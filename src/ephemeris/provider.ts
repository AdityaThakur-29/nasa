/**
 * Ephemeris provider contract.
 *
 * THE ABSTRACTION BOUNDARY (contract section 9). The simulation layer must not
 * know whether a position came from an analytic Keplerian fit, a truncated
 * lunar theory, satellite mean elements, or a downloaded JPL Horizons vector.
 * It asks a provider for a state and receives one, together with metadata
 * describing what the number actually is.
 *
 * WHY METADATA IS MANDATORY RATHER THAN OPTIONAL: every model here is an
 * approximation with a stated error and a stated validity interval. A position
 * without that context invites being displayed as though it were measured.
 * Requiring providers to publish their model name, accuracy and valid range
 * makes honest presentation the default and silence impossible.
 *
 * VOCABULARY (contract sections 10, 11 and 27). Nothing in this layer is
 * "telemetry", "live" or "exact". A value produced here is COMPUTED from a
 * MODEL. Those are the words used.
 */

import type { JulianDate } from '../core/jd';
import type { Vector3Like } from './kepler';

/**
 * Reference frame of a state vector.
 *
 * Carried on the value rather than assumed by convention. A silent frame
 * mismatch rotates a position by the obliquity, about 23.4 degrees, which is
 * large enough to be obviously wrong on screen but small enough to be mistaken
 * for an orbital-element error if the frame is not explicit.
 */
export type ReferenceFrame =
  /** Mean ecliptic and equinox of J2000. The frame the JPL element tables use. */
  | 'J2000_ECLIPTIC'
  /** J2000 mean equator, equivalent to ICRF at this accuracy. */
  | 'J2000_EQUATORIAL';

/**
 * Origin a state vector is measured from.
 *
 * Distinguishing these prevents a heliocentric vector being added to a
 * planetocentric one. The Moon's position is naturally geocentric; Earth's is
 * heliocentric. Composing them requires knowing which is which.
 */
export type StateOrigin =
  | 'SUN'
  | 'SOLAR_SYSTEM_BARYCENTRE'
  | 'EARTH_MOON_BARYCENTRE'
  | { readonly bodyId: string };

/**
 * Epistemic status of a computed value (contract sections 10 and 11).
 *
 * Never "MEASURED": no value this application produces is a measurement.
 */
export type ComputationStatus =
  /** Produced by evaluating a model at the requested instant. */
  | 'COMPUTED'
  /** Interpolated between tabulated samples. */
  | 'INTERPOLATED'
  /** Model evaluated outside its stated validity interval. */
  | 'OUT_OF_RANGE';

/**
 * A body's state at an instant, in physical units.
 *
 * ALWAYS kilometres and km/s. Render-space scaling happens later and elsewhere,
 * and must never reach back into these numbers.
 */
export interface BodyState {
  readonly bodyId: string;
  /** Position, km. */
  readonly positionKm: Vector3Like;
  /**
   * Velocity, km/s.
   *
   * May be null where a provider models position only. A consumer that needs
   * velocity must handle the absence rather than receive a fabricated zero.
   */
  readonly velocityKmS: Vector3Like | null;
  readonly frame: ReferenceFrame;
  readonly origin: StateOrigin;
  /** Instant the state was computed for, in the scale the provider required. */
  readonly epoch: JulianDate;
  readonly status: ComputationStatus;
}

/**
 * Validity interval, as Julian Dates.
 *
 * Contract section 9 specifies numeric start and end. These are JD numbers,
 * which is lossy at the microsecond level but entirely adequate for describing
 * an interval spanning centuries.
 */
export interface ValidRange {
  readonly start: number;
  readonly end: number;
}

/** What a provider must disclose about itself for a given body. */
export interface EphemerisMetadata {
  readonly id: string;
  /** Human-readable model name, shown in the interface verbatim. */
  readonly model: string;
  /**
   * Accuracy statement, as published by the source.
   *
   * A string rather than a number because published accuracies are
   * multi-dimensional: the JPL tables quote separate longitude, latitude and
   * distance errors. Compressing that into one number would discard
   * information the interface should be able to show.
   */
  readonly accuracy: string;
  readonly validRange: ValidRange;
  /** Provenance identifier from src/data/sources.md. */
  readonly source: string;
  /** Time scale the model's independent variable is defined in. */
  readonly timeScale: 'TT' | 'TDB' | 'UTC';
  readonly frame: ReferenceFrame;
  readonly origin: StateOrigin;
  /** Known limitations, surfaced rather than buried. */
  readonly limitations?: readonly string[];
}

/**
 * A source of body states.
 *
 * Implementations must be PURE with respect to the requested instant: calling
 * getState twice with the same arguments must return the same numbers. Caching
 * is permitted, mutation of returned values is not.
 */
export interface EphemerisProvider {
  /** Stable identifier for this provider. */
  readonly id: string;

  /** Body ids this provider can supply, for capability discovery. */
  readonly supportedBodies: readonly string[];

  /**
   * Computes a body's state at an instant.
   *
   * @throws if the body is not supported. Being outside the validity interval is
   *   NOT an error: the state is returned with status OUT_OF_RANGE so the
   *   interface can display the position and warn about it, rather than the
   *   simulation stalling at a boundary.
   */
  getState(bodyId: string, jd: JulianDate<'TT'>): BodyState;

  /** Discloses the model behind a body's state. @throws if unsupported. */
  getMetadata(bodyId: string): EphemerisMetadata;
}

/** True when a provider can supply the given body. */
export function supportsBody(provider: EphemerisProvider, bodyId: string): boolean {
  return provider.supportedBodies.includes(bodyId);
}

/**
 * Routes each body to the provider that handles it.
 *
 * How heterogeneous models coexist without the simulation layer knowing: the
 * JPL fit supplies planets, a lunar theory supplies the Moon, satellite mean
 * elements supply moons. Registration order decides precedence, so a
 * higher-fidelity provider registered later can take over a body.
 */
export class ProviderRegistry implements EphemerisProvider {
  readonly id = 'registry';

  private readonly providers: EphemerisProvider[] = [];
  private readonly routes = new Map<string, EphemerisProvider>();

  /** Later registrations override earlier ones for the same body. */
  register(provider: EphemerisProvider): void {
    this.providers.push(provider);
    for (const bodyId of provider.supportedBodies) {
      this.routes.set(bodyId, provider);
    }
  }

  get supportedBodies(): readonly string[] {
    return [...this.routes.keys()];
  }

  getState(bodyId: string, jd: JulianDate<'TT'>): BodyState {
    return this.resolve(bodyId).getState(bodyId, jd);
  }

  getMetadata(bodyId: string): EphemerisMetadata {
    return this.resolve(bodyId).getMetadata(bodyId);
  }

  /** The provider serving a body, for interface disclosure. */
  providerFor(bodyId: string): EphemerisProvider {
    return this.resolve(bodyId);
  }

  /** Every registered provider, for a credits or diagnostics panel. */
  allProviders(): readonly EphemerisProvider[] {
    return [...this.providers];
  }

  private resolve(bodyId: string): EphemerisProvider {
    const provider = this.routes.get(bodyId);
    if (provider === undefined) {
      throw new Error(
        `ProviderRegistry: no provider for "${bodyId}"; registered: ${
          this.supportedBodies.join(', ') || '(none)'
        }`,
      );
    }
    return provider;
  }
}
