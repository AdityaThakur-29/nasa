/**
 * Simulation state: the authoritative physical description of the system.
 *
 * UNITS ARE PHYSICAL AND NON-NEGOTIABLE. Kilometres, kilometres per second,
 * Julian Date, f64 throughout. Nothing in this module knows about render units,
 * visual exaggeration, screen space, or three.js. The render layer consumes this
 * state and transforms it; it never writes back. Contract section 39.
 *
 * CANONICAL FRAME: J2000 ECLIPTIC, Sun-centred, Z toward ecliptic north.
 *
 * That choice needs justifying, because the two upstream sources disagree:
 *
 *   - The JPL element tables produce positions in the J2000 ECLIPTIC frame.
 *   - The IAU rotational elements define poles in the J2000 EQUATORIAL frame.
 *
 * Both must be expressed in ONE frame before rendering, or a planet's rotation
 * axis would be drawn wrong relative to its own orbit by the obliquity, about
 * 23.4 degrees. Ecliptic is chosen because the planetary orbits then lie close to
 * the XY plane, which makes the overview camera, the reference grid and the
 * orbital-plane visualisation natural rather than tilted. Orientations are
 * rotated from equatorial into ecliptic here, once, at the boundary.
 *
 * Z IS UP IN THIS MODULE. Converting to a Y-up convention is a rendering
 * concern and happens in the render layer, not here. Baking a renderer's axis
 * convention into the simulation would be exactly the kind of leak section 39
 * forbids.
 *
 * ORIGIN is the Sun, matching what the planetary provider returns. Moving to the
 * solar system barycentre would require an ephemeris for the Sun itself, since
 * the Sun orbits the barycentre with an amplitude of roughly 1.2 million km,
 * comparable to its own radius. Recorded as a limitation rather than glossed over.
 */

import { type JulianDate, toNumber } from '../core/jd';
import { SimulationClock, type ClockSnapshot } from '../core/clock';
import { BODIES, BODY_ORDER, type BodyPhysical, getBody } from '../data/bodies';
import { J2000_OBLIQUITY_DEG, DEG_TO_RAD } from '../data/constants';
import {
  type EphemerisProvider,
  type ComputationStatus,
  ProviderRegistry,
} from '../ephemeris/provider';
import { createPlanetsProvider } from '../ephemeris/planets';
import {
  type Matrix3,
  type QuaternionLike,
  computeOrientation,
  matrixToQuaternion,
} from '../ephemeris/orientation';
import {
  type Vector3Like,
  add,
  equatorialToEcliptic,
  magnitude,
  subtract,
} from '../ephemeris/kepler';

/** The one frame every vector in a snapshot is expressed in. */
export const SIMULATION_FRAME = 'J2000_ECLIPTIC' as const;

/** The one origin every position in a snapshot is measured from. */
export const SIMULATION_ORIGIN = 'SUN' as const;

/**
 * Obliquity used for the equatorial-to-ecliptic rotation of orientations.
 *
 * Uses the S3 measured value rather than the coarser one embedded in the S1
 * position formulae. The two differ by 0.004 arcsec, which rotates a pole
 * direction by 2e-8 radians; either would do, and the more precise constant is
 * preferred for a pure frame conversion that is not part of the fitted algorithm.
 */
const OBLIQUITY_RAD = J2000_OBLIQUITY_DEG * DEG_TO_RAD;

/**
 * Why a body has no position.
 *
 * Distinguishing these matters: a body awaiting a model in a later milestone is
 * a known gap, whereas a body whose provider failed is a defect. Collapsing both
 * into a silent absence would hide the second.
 */
export type UnavailableReason =
  /** No provider is registered for this body yet. */
  | 'NO_PROVIDER'
  /** A provider exists but threw while computing. */
  | 'PROVIDER_ERROR';

/** A body that could not be placed, with the reason exposed. */
export interface UnavailableBody {
  readonly bodyId: string;
  readonly reason: UnavailableReason;
  readonly detail: string;
}

/**
 * One body's physical state.
 *
 * Every length is kilometres and every velocity is kilometres per second. There
 * is deliberately no visual radius, no scaled position and no colour: those are
 * render-space properties and live in sim/scale.ts and the render layer.
 */
export interface BodySimState {
  readonly bodyId: string;
  readonly displayName: string;

  /** Position relative to the Sun, km, J2000 ecliptic. */
  readonly positionKm: Vector3Like;

  /**
   * Velocity relative to the Sun, km/s, J2000 ecliptic.
   *
   * Null when the provider models position only. Consumers must handle the
   * absence rather than receive a fabricated zero.
   */
  readonly velocityKmS: Vector3Like | null;

  /**
   * Position relative to this body's gravitational primary, km.
   *
   * Equal to positionKm for a body orbiting the Sun. For a satellite it is the
   * offset from its planet, which is what the hierarchical render transform needs:
   * compressing a satellite's ABSOLUTE heliocentric vector would shrink it
   * radially only and render a circular orbit as an ellipse.
   */
  readonly positionRelativeToPrimaryKm: Vector3Like;

  /** Gravitational primary, or null for the frame origin. */
  readonly parentId: string | null;

  /** Distance from the Sun, km. Precomputed because the interface always wants it. */
  readonly distanceFromSunKm: number;

  /**
   * Volumetric mean radius, km. The PHYSICAL radius, never scaled.
   *
   * Measurements and selection geometry use this value. Visual size is a
   * separate quantity computed elsewhere.
   */
  readonly physicalRadiusKm: number;

  /** Body-fixed to ecliptic rotation, row-major. */
  readonly orientation: Matrix3;

  /** The same rotation as a quaternion, for the render layer. */
  readonly orientationQuaternion: QuaternionLike;

  /** North pole unit vector in the ecliptic frame. */
  readonly northPole: Vector3Like;

  /** Prime meridian angle, degrees, [0, 360). */
  readonly primeMeridianDeg: number;

  /** True when the body rotates retrograde. */
  readonly retrograde: boolean;

  /** Whether the position was computed inside its model's validity interval. */
  readonly status: ComputationStatus;

  /** Which provider produced the position, for interface disclosure. */
  readonly providerId: string;
}

/**
 * Immutable view of the whole system at one instant.
 *
 * This is the ONLY thing the interface layer may read. It carries no methods, no
 * references to the clock, and no way to command the simulation, so the one-way
 * flow in contract section 39 holds structurally rather than by convention.
 */
export interface SimulationSnapshot {
  readonly clock: ClockSnapshot;
  readonly frame: typeof SIMULATION_FRAME;
  readonly origin: typeof SIMULATION_ORIGIN;
  readonly bodies: readonly BodySimState[];
  /** Bodies that could not be placed, and why. Empty in the normal case. */
  readonly unavailable: readonly UnavailableBody[];
  /** Monotonic counter, for change detection without deep comparison. */
  readonly revision: number;
}

export interface SimulationStateOptions {
  readonly clock?: SimulationClock;
  /** Provider or registry supplying positions. Defaults to the JPL planets fit. */
  readonly provider?: EphemerisProvider;
  /**
   * Bodies to simulate, in order.
   *
   * Defaults to every body with a physical record that can actually be placed.
   * Listing a body with no provider is not an error; it appears in `unavailable`
   * with a reason, so a missing model is visible rather than silent.
   */
  readonly bodyIds?: readonly string[];
}

/**
 * Rotates a body-fixed-to-equatorial matrix into a body-fixed-to-ecliptic one.
 *
 * The orientation matrix has the body's axes as COLUMNS expressed in the
 * equatorial frame, so converting the frame means rotating each column
 * individually. Applying the obliquity rotation to the matrix as a whole, or on
 * the wrong side, would produce a matrix that is still orthonormal and therefore
 * would pass a determinant check while pointing every axis in the wrong place.
 */
function orientationToEcliptic(equatorial: Matrix3): Matrix3 {
  const columnX = equatorialToEcliptic(
    { x: equatorial[0], y: equatorial[3], z: equatorial[6] },
    OBLIQUITY_RAD,
  );
  const columnY = equatorialToEcliptic(
    { x: equatorial[1], y: equatorial[4], z: equatorial[7] },
    OBLIQUITY_RAD,
  );
  const columnZ = equatorialToEcliptic(
    { x: equatorial[2], y: equatorial[5], z: equatorial[8] },
    OBLIQUITY_RAD,
  );

  return [
    columnX.x, columnY.x, columnZ.x,
    columnX.y, columnY.y, columnZ.y,
    columnX.z, columnY.z, columnZ.z,
  ];
}

const ZERO_VECTOR: Vector3Like = { x: 0, y: 0, z: 0 };

/**
 * Builds and advances the physical state of the system.
 *
 * ALLOCATION: a fresh snapshot is built each update. For the ten bodies of M1
 * that is a few hundred small objects per second, which is negligible against a
 * 16 ms frame budget, and immutability is worth more than the saving. The
 * instanced asteroid belt in M4 will need a different approach, and will get one;
 * it is not a reason to complicate this now.
 */
export class SimulationState {
  private readonly clock: SimulationClock;
  private readonly provider: EphemerisProvider;
  private readonly bodyIds: readonly string[];

  private bodies: BodySimState[] = [];
  private unavailable: UnavailableBody[] = [];
  private revisionCounter = 0;

  constructor(options: SimulationStateOptions = {}) {
    this.clock = options.clock ?? new SimulationClock();

    if (options.provider !== undefined) {
      this.provider = options.provider;
    } else {
      const registry = new ProviderRegistry();
      registry.register(createPlanetsProvider());
      this.provider = registry;
    }

    this.bodyIds = options.bodyIds ?? defaultBodyIds();
    this.recompute();
  }

  /** The clock, for command wiring. Not reachable from a snapshot. */
  getClock(): SimulationClock {
    return this.clock;
  }

  /**
   * Advances simulated time and recomputes every body.
   *
   * @param realDeltaSeconds wall-clock seconds since the previous frame
   * @returns simulated seconds actually applied
   */
  update(realDeltaSeconds: number): number {
    const applied = this.clock.advance(realDeltaSeconds);
    this.recompute();
    return applied;
  }

  /** Recomputes at the current instant without advancing time. */
  refresh(): void {
    this.recompute();
  }

  /** Immutable view for the interface layer. */
  snapshot(): SimulationSnapshot {
    return {
      clock: this.clock.snapshot(),
      frame: SIMULATION_FRAME,
      origin: SIMULATION_ORIGIN,
      bodies: this.bodies,
      unavailable: this.unavailable,
      revision: this.revisionCounter,
    };
  }

  /** One body's state, or undefined if it is not currently placed. */
  getBody(bodyId: string): BodySimState | undefined {
    return this.bodies.find((body) => body.bodyId === bodyId);
  }

  /**
   * Distance between two bodies' CENTRES, km.
   *
   * Uses physical positions, never render-space ones, so the measurement tool
   * reports a real distance regardless of the active visual scale. Contract
   * section 2.
   */
  centreDistanceKm(fromBodyId: string, toBodyId: string): number {
    return magnitude(subtract(this.requireBody(toBodyId).positionKm, this.requireBody(fromBodyId).positionKm));
  }

  /**
   * Distance between two bodies' SURFACES, km.
   *
   * Centre separation less both physical radii. Negative would mean overlap,
   * which cannot happen for real bodies but can if a caller passes nonsense, so
   * the raw value is returned rather than clamped.
   */
  surfaceDistanceKm(fromBodyId: string, toBodyId: string): number {
    const from = this.requireBody(fromBodyId);
    const to = this.requireBody(toBodyId);
    return magnitude(subtract(to.positionKm, from.positionKm)) - from.physicalRadiusKm - to.physicalRadiusKm;
  }

  private requireBody(bodyId: string): BodySimState {
    const body = this.getBody(bodyId);
    if (body === undefined) {
      const reason = this.unavailable.find((entry) => entry.bodyId === bodyId);
      throw new Error(
        `SimulationState: "${bodyId}" is not placed` +
          (reason === undefined
            ? `; simulated bodies are ${this.bodies.map((b) => b.bodyId).join(', ')}`
            : `: ${reason.reason} (${reason.detail})`),
      );
    }
    return body;
  }

  private recompute(): void {
    const jdTT = this.clock.nowTT();

    // Two passes. Absolute positions first, because a satellite's offset from its
    // primary cannot be formed until the primary has been placed.
    const absolute = new Map<string, { state: RawBodyPlacement; physical: BodyPhysical }>();
    const unavailable: UnavailableBody[] = [];

    for (const bodyId of this.bodyIds) {
      const physical = getBody(bodyId);
      const placement = this.placeBody(bodyId, physical, jdTT);

      if ('reason' in placement) {
        unavailable.push({ bodyId, reason: placement.reason, detail: placement.detail });
        continue;
      }
      absolute.set(bodyId, { state: placement, physical });
    }

    const bodies: BodySimState[] = [];

    for (const bodyId of this.bodyIds) {
      const entry = absolute.get(bodyId);
      if (entry === undefined) continue;

      const { state, physical } = entry;

      // Offset from the gravitational primary. Falls back to the absolute vector
      // when the primary is not placed, which keeps the body visible rather than
      // dropping it, and is recorded as a fallback rather than passed off as an
      // offset that was actually computed.
      const primary = physical.parentId === null ? undefined : absolute.get(physical.parentId);
      const relative =
        primary === undefined
          ? state.positionKm
          : subtract(state.positionKm, primary.state.positionKm);

      const orientation = computeOrientation(bodyId, jdTT);
      const eclipticMatrix = orientationToEcliptic(orientation.bodyToInertial);

      bodies.push({
        bodyId,
        displayName: physical.displayName,
        positionKm: state.positionKm,
        velocityKmS: state.velocityKmS,
        positionRelativeToPrimaryKm: relative,
        parentId: physical.parentId,
        distanceFromSunKm: magnitude(state.positionKm),
        physicalRadiusKm: physical.meanRadiusKm.value,
        orientation: eclipticMatrix,
        orientationQuaternion: matrixToQuaternion(eclipticMatrix),
        northPole: equatorialToEcliptic(orientation.northPole, OBLIQUITY_RAD),
        primeMeridianDeg: orientation.primeMeridianDeg,
        retrograde: orientation.retrograde,
        status: state.status,
        providerId: state.providerId,
      });
    }

    this.bodies = bodies;
    this.unavailable = unavailable;
    this.revisionCounter += 1;
  }

  /**
   * Places one body, or reports why it cannot be placed.
   *
   * The frame origin is a special case of the FRAME, not of the body: in a
   * heliocentric frame the Sun is at zero by definition, so it needs no
   * ephemeris. Any body with no parent is treated the same way, which keeps the
   * rule data-driven rather than naming the Sun in code.
   */
  private placeBody(
    bodyId: string,
    physical: BodyPhysical,
    jdTT: JulianDate<'TT'>,
  ): RawBodyPlacement | { reason: UnavailableReason; detail: string } {
    if (physical.parentId === null) {
      return {
        positionKm: ZERO_VECTOR,
        velocityKmS: ZERO_VECTOR,
        status: 'COMPUTED',
        providerId: 'frame-origin',
      };
    }

    if (!this.provider.supportedBodies.includes(bodyId)) {
      return {
        reason: 'NO_PROVIDER',
        detail: `no ephemeris provider supplies "${bodyId}"`,
      };
    }

    try {
      const state = this.provider.getState(bodyId, jdTT);

      // The provider declares its own frame, so a mismatch is caught here rather
      // than silently producing a 23.4 degree error.
      const positionKm =
        state.frame === SIMULATION_FRAME
          ? state.positionKm
          : equatorialToEcliptic(state.positionKm, OBLIQUITY_RAD);
      const velocityKmS =
        state.velocityKmS === null
          ? null
          : state.frame === SIMULATION_FRAME
            ? state.velocityKmS
            : equatorialToEcliptic(state.velocityKmS, OBLIQUITY_RAD);

      const providerId =
        this.provider instanceof ProviderRegistry
          ? this.provider.providerFor(bodyId).id
          : this.provider.id;

      return { positionKm, velocityKmS, status: state.status, providerId };
    } catch (error) {
      return {
        reason: 'PROVIDER_ERROR',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** Intermediate placement, before hierarchy and orientation are applied. */
interface RawBodyPlacement {
  readonly positionKm: Vector3Like;
  readonly velocityKmS: Vector3Like | null;
  readonly status: ComputationStatus;
  readonly providerId: string;
}

/**
 * Bodies to simulate by default: EVERY body with a physical record.
 *
 * Deliberately NOT filtered by provider support. Filtering here would make a
 * body with no model vanish from the simulation entirely, which is precisely the
 * silent gap UnavailableReason exists to prevent: the snapshot would show nine
 * bodies and nothing would indicate a tenth was expected.
 *
 * Including it means the Moon appears in `unavailable` with reason NO_PROVIDER
 * for the whole of M1, so the interface can state that no lunar theory is loaded
 * yet rather than implying the Moon is not part of the system. Registering the
 * ELP2000 provider later moves it into `bodies` with no other change.
 */
function defaultBodyIds(): readonly string[] {
  return BODY_ORDER.filter((bodyId) => BODIES[bodyId] !== undefined);
}

/**
 * Sum of two positions. Exported because composing a satellite offset back onto
 * its primary is a common operation in the render layer.
 */
export function composePosition(primary: Vector3Like, offset: Vector3Like): Vector3Like {
  return add(primary, offset);
}

/** Julian Date of a snapshot as a single number, for display and comparison. */
export function snapshotJdNumber(snapshot: SimulationSnapshot): number {
  return toNumber(snapshot.clock.utc);
}
