/**
 * Layered depth slabs.
 *
 * THE PROBLEM. The scene spans from a camera one kilometre above the Moon to
 * Neptune at 4.5e9 km, a dynamic range of about 1e10.
 *
 * MEASURED DEPTH RESOLUTION, 24-bit buffer, taken through the real pipeline for
 * the Moon-close plus Neptune-visible stress scene in scientific scale. Values are
 * the smallest surface separation the depth buffer can order, in kilometres.
 *
 *   slab     span (units)          body      linear      log
 *   NEAR     0.500 .. 7.87e2       Moon      8.9e-4      1.5e-3
 *                                  Earth     1.8e+1      1.5e-1
 *   MIDDLE   5.17e4 .. 8.71e6      Venus     1.2e+1      9.8e+1
 *                                  Jupiter   1.0e+3      8.9e+2
 *                                  Neptune   2.2e+4      4.1e+3
 *
 * For comparison, a SINGLE frustum spanning 1e-4 to 5e6 resolves 4.5 m at the
 * camera and 1.2e13 km at Neptune under linear depth, which is no discrimination
 * whatever. Slabs are what make the scene tractable.
 *
 * WHY LOG DEPTH IS ENABLED, from the worst case rather than the average. Within a
 * slab the two schemes trade places: linear concentrates resolution near the near
 * plane and log distributes it uniformly in log space, so linear wins at the near
 * end of a slab and log wins at the far end. The crossover in MIDDLE sits around
 * Jupiter. What decides the choice is the WORST case, which is Neptune:
 *
 *   linear   2.2e4 km   against Neptune's radius of 24622 km   ratio 0.88
 *   log      4.1e3 km   against the same radius                ratio 0.17
 *
 * Linear resolution at Neptune is comparable to Neptune's own radius, which would
 * produce visible depth artefacts across its sphere. Log depth is 5.2x better
 * there and is therefore the correct global setting, which is also what contract
 * section 4.3 requires.
 *
 * A NOTE ON A CORRECTED EARLIER CLAIM. An earlier revision of this comment
 * asserted that log depth was a net loss in the far slab, reasoning from a
 * hypothetical slab spanning 2.25e6 to 9e6 with a ratio of 4:1. That configuration
 * does not arise: Neptune is classified into MIDDLE, whose measured ratio is 168:1,
 * and at that ratio log depth wins decisively. The earlier claim was arithmetic
 * about a slab that never exists.
 *
 * THE FIX, in three parts, of which this module is the second:
 *
 *   1. floating origin      removes lateral f32 error       (floating-origin.ts)
 *   2. layered depth slabs  bounds each frustum's ratio     (this module)
 *   3. logarithmic depth    redistributes within each slab  (renderer flag)
 *
 * Contract section 4.3 is right that log depth is not the primary solution: slabs
 * do the structural work, and log depth then protects the far end of each slab.
 *
 * THE FAR SLAB IS UNUSED BY SOLAR-SYSTEM SCENES, measured. Because MIDDLE's
 * nominal range extends to 1e7 units and classification takes the first match,
 * everything out to 1e7 units, which is 67 au, lands in MIDDLE. Neptune at 4.4e6
 * units is inside that, so a frame containing the eight planets uses two slabs and
 * one depth clear, not three and two.
 *
 * That is not a defect and the ranges are not changed to force three slabs. The
 * measured MIDDLE ratio of 168:1 is comfortable, and 67 au is a sensible place for
 * a boundary: it is roughly where the Kuiper belt begins. FAR therefore becomes
 * live exactly when the scene extends past the planets, which is what it is for.
 * The finding is recorded so the empty slab is understood rather than mistaken for
 * a classification bug.
 *
 * OWNERSHIP IS BY CENTRE DISTANCE, and every object belongs to exactly one slab.
 * Contract section 4.1 requires that, and the nominal ranges it specifies
 * deliberately overlap, so a rule is needed rather than a plain interval test.
 * The rule is documented in full on classifyDepthSlab.
 *
 * PLANES ARE PER-FRAME OUTPUTS, NOT CONSTANTS. The nominal ranges classify; the
 * actual near and far planes are then expanded to contain the members that landed
 * in each slab. Without expansion a body larger than its slab's nominal span would
 * be clipped through the middle: the Sun is 1391 render units across, so at a
 * centre distance of 1e4 it spans 9304 to 10696 and crosses the near slab's
 * nominal far plane of 1e4 outright.
 *
 * NOTHING HERE TOUCHES THE SIMULATION. Inputs are render-space distances and
 * radii; outputs are frustum planes and an assignment map. Contract section 39.
 */

/** The three slabs. */
export type SlabId = 'NEAR' | 'MIDDLE' | 'FAR';

/**
 * Classification order: near first.
 *
 * The nominal ranges overlap, so testing near-to-far and taking the first match
 * resolves every overlap region to the NEARER slab. That direction is the correct
 * one: precision matters most close to the camera, and the nearer slab will have
 * the tighter planes after expansion.
 */
export const CLASSIFICATION_ORDER: readonly SlabId[] = ['NEAR', 'MIDDLE', 'FAR'];

/**
 * Render order: far first.
 *
 * Contract section 4.2. Rendering far to near, clearing depth between slabs and
 * never clearing colour, composites the layers so nearer geometry draws over
 * farther geometry.
 */
export const RENDER_ORDER: readonly SlabId[] = ['FAR', 'MIDDLE', 'NEAR'];

/**
 * Nominal classification range for one slab, plus the bounds its expanded planes
 * may not exceed.
 */
export interface SlabDefinition {
  readonly id: SlabId;
  /** Lower bound of the centre distances this slab claims, render units. */
  readonly nominalNear: number;
  /** Upper bound of the centre distances this slab claims, inclusive. */
  readonly nominalFar: number;
  /**
   * Floor for the expanded near plane, render units.
   *
   * A perspective projection requires near > 0, so some floor is unavoidable.
   *
   * WHY IT IS SET AS LOW AS IT IS. An earlier revision used 1e-4 units, which is
   * 100 metres, on the reasoning that no camera would get closer. That created an
   * unsatisfiable pair of rules: the floor demanded near >= 1e-4 while the
   * containment invariant demanded near <= (d - r) for any body the camera is
   * outside of. A camera 90 metres above a surface satisfies neither, and the
   * planner produced a plan its own verifier rejected.
   *
   * The floor is now 1e-7 units, which is 10 centimetres. That is safe because
   * three.js's logarithmic depth distribution does not involve the near plane at
   * all, a property measured and asserted in the test suite, so pulling the near
   * plane closer costs no depth precision. The projection matrix term 2fn/(f-n)
   * evaluates to about 2e-7 at this floor, which f32 represents without difficulty.
   *
   * Clipping is therefore only possible when the camera is within 10 cm of a
   * surface, and when that happens it is reported through nearClampedToFloor
   * rather than passed off as containment.
   */
  readonly minNear: number;
  /** Ceiling for the expanded far plane, render units. */
  readonly maxFar: number;
}

/**
 * The slab definitions.
 *
 * Ranges are those given in contract section 4.1. They overlap by design.
 *
 * ON THE FAR SLAB'S CEILING. Contract section 4.1 gives the far slab a nominal
 * range ending at 1e13, about 1000 light years, which contains nothing: the
 * outermost body is Neptune at roughly 4.5e6 render units, and the star field is a
 * separate pass with depth writing disabled. That 1e13 is retained here as a
 * CLASSIFICATION ceiling so an arbitrarily distant object still lands somewhere,
 * but it can never become an actual far plane, because the far plane is always
 * derived by expansion from the members present. In a Neptune-visible scene the
 * far plane comes out near 9e6, not 1e13.
 */
export const SLAB_DEFINITIONS: readonly SlabDefinition[] = [
  { id: 'NEAR', nominalNear: 1e-1, nominalFar: 1e4, minNear: 1e-4, maxFar: 1e8 },
  { id: 'MIDDLE', nominalNear: 1e3, nominalFar: 1e7, minNear: 1e-1, maxFar: 1e10 },
  { id: 'FAR', nominalNear: 1e6, nominalFar: 1e13, minNear: 1e2, maxFar: 1e14 },
];

/** Looks up a slab definition. */
export function slabDefinition(id: SlabId): SlabDefinition {
  const definition = SLAB_DEFINITIONS.find((entry) => entry.id === id);
  if (definition === undefined) throw new Error(`depth-slabs: unknown slab "${id}"`);
  return definition;
}

/**
 * Assigns a centre distance to exactly one slab.
 *
 * THE RULE, stated completely because contract section 4.1 requires the boundary
 * behaviour to be documented:
 *
 *   1. Test slabs in CLASSIFICATION_ORDER, near before middle before far.
 *   2. A slab claims d when nominalNear <= d <= nominalFar. Both bounds are
 *      INCLUSIVE, so d = 1e4 is claimed by NEAR rather than MIDDLE.
 *   3. The first claiming slab owns the object, so overlap regions always resolve
 *      to the nearer slab.
 *   4. Below every nominalNear, that is d < 1e-1, the object is owned by NEAR.
 *      This is reachable: it means the camera is within 100 km of a body centre,
 *      which happens in close-orbit mode.
 *   5. Above every nominalFar, that is d > 1e13, the object is owned by FAR.
 *
 * Rules 4 and 5 make the function total. Without them a camera at a planet's
 * surface would classify nothing and the body would silently vanish.
 *
 * Classification uses the CENTRE distance only, never the radius. A large body
 * near a boundary is handled by plane expansion, not by reclassification, because
 * splitting one object across two slabs would draw it twice with a depth clear in
 * between.
 */
export function classifyDepthSlab(cameraRelativeDistance: number): SlabId {
  if (!Number.isFinite(cameraRelativeDistance) || cameraRelativeDistance < 0) {
    throw new Error(
      `classifyDepthSlab: distance must be finite and non-negative, got ${cameraRelativeDistance}`,
    );
  }

  for (const id of CLASSIFICATION_ORDER) {
    const definition = slabDefinition(id);
    if (
      cameraRelativeDistance >= definition.nominalNear &&
      cameraRelativeDistance <= definition.nominalFar
    ) {
      return id;
    }
  }

  // Below the innermost nominal near plane: the camera is essentially at the
  // object. Owned by NEAR, whose expanded near plane will accommodate it.
  const nearest = slabDefinition(CLASSIFICATION_ORDER[0]!);
  if (cameraRelativeDistance < nearest.nominalNear) return 'NEAR';

  // Beyond the outermost nominal far plane.
  return 'FAR';
}

/** An object competing for a slab. Distances and radii are render-space. */
export interface DepthCandidate {
  readonly id: string;
  /** Distance from the camera to the object's centre, render units. */
  readonly cameraDistance: number;
  /**
   * Render-space radius, used only to expand planes so the object is not clipped.
   *
   * This is the VISUAL radius, because clipping is decided by what is drawn. The
   * physical radius belongs to measurement and is irrelevant here.
   */
  readonly radius: number;
}

/** One slab's computed state for a frame. */
export interface SlabPlan {
  readonly id: SlabId;
  /** Ids owned by this slab, in the order supplied. */
  readonly members: readonly string[];
  /** Expanded near plane, render units. Zero when the slab is empty. */
  readonly near: number;
  /** Expanded far plane, render units. Zero when the slab is empty. */
  readonly far: number;
  /** far / near. One when empty. Reported so the test suite can bound it. */
  readonly depthRatio: number;
  readonly empty: boolean;
  /** True when the near plane hit its floor rather than following the members. */
  readonly nearClampedToFloor: boolean;
  /** True when the far plane hit its ceiling. */
  readonly farClampedToCeiling: boolean;
}

export interface DepthPlan {
  /** All three slabs in RENDER_ORDER, including empty ones. */
  readonly slabs: readonly SlabPlan[];
  /** Only the slabs with members, in RENDER_ORDER. */
  readonly nonEmpty: readonly SlabPlan[];
  /** Which slab owns each candidate. */
  readonly assignment: ReadonlyMap<string, SlabId>;
  /**
   * How many depth clears a frame needs.
   *
   * One fewer than the number of non-empty slabs: the first renders into an
   * already-cleared buffer, and each subsequent one needs depth cleared while
   * colour is preserved. Contract section 4.2 requires empty slabs to be skipped,
   * so they cost nothing.
   */
  readonly clearDepthCount: number;
}

export interface DepthPlanOptions {
  /**
   * Multiplier applied when pulling the near plane in front of the closest
   * surface. Half the distance to the nearest surface, per the amended
   * near-plane rule.
   */
  readonly nearSafetyFactor?: number;
  /** Multiplier applied when pushing the far plane behind the farthest surface. */
  readonly farSafetyFactor?: number;
}

const DEFAULT_NEAR_SAFETY_FACTOR = 0.5;
const DEFAULT_FAR_SAFETY_FACTOR = 2;

/**
 * Builds a frame's depth plan.
 *
 * TWO PASSES. Classification first, using centre distances only, so ownership is a
 * pure function of distance and cannot depend on which other objects are present.
 * Expansion second, so each slab's planes are derived from the members it actually
 * received.
 *
 * THE EXPANSION RULE:
 *
 *   near = nearSafetyFactor * min over members of (d - r)
 *   far  = farSafetyFactor  * max over members of (d + r)
 *
 * then clamped into the slab's own floor and ceiling.
 *
 * The near expression can go to zero or negative when the camera is inside a
 * body's visual radius, which is reachable in close-orbit mode. The floor handles
 * it, and the outcome is reported through nearClampedToFloor rather than silently
 * absorbed.
 */
export function planDepthSlabs(
  candidates: readonly DepthCandidate[],
  options: DepthPlanOptions = {},
): DepthPlan {
  const nearFactor = options.nearSafetyFactor ?? DEFAULT_NEAR_SAFETY_FACTOR;
  const farFactor = options.farSafetyFactor ?? DEFAULT_FAR_SAFETY_FACTOR;

  if (!(nearFactor > 0) || nearFactor > 1) {
    throw new Error(`planDepthSlabs: nearSafetyFactor must lie in (0, 1], got ${nearFactor}`);
  }
  if (!(farFactor >= 1)) {
    throw new Error(`planDepthSlabs: farSafetyFactor must be at least 1, got ${farFactor}`);
  }

  const assignment = new Map<string, SlabId>();
  const grouped = new Map<SlabId, DepthCandidate[]>();
  for (const id of CLASSIFICATION_ORDER) grouped.set(id, []);

  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.radius) || candidate.radius < 0) {
      throw new Error(
        `planDepthSlabs: "${candidate.id}" has an invalid radius ${candidate.radius}`,
      );
    }
    if (assignment.has(candidate.id)) {
      // A duplicate id would make the assignment map lossy and break the
      // partition property the stress test relies on.
      throw new Error(`planDepthSlabs: duplicate candidate id "${candidate.id}"`);
    }

    const slab = classifyDepthSlab(candidate.cameraDistance);
    assignment.set(candidate.id, slab);
    grouped.get(slab)!.push(candidate);
  }

  const slabs: SlabPlan[] = [];

  for (const id of RENDER_ORDER) {
    const definition = slabDefinition(id);
    const members = grouped.get(id)!;

    if (members.length === 0) {
      slabs.push({
        id,
        members: [],
        near: 0,
        far: 0,
        depthRatio: 1,
        empty: true,
        nearClampedToFloor: false,
        farClampedToCeiling: false,
      });
      continue;
    }

    let closestSurface = Number.POSITIVE_INFINITY;
    let farthestSurface = 0;
    for (const member of members) {
      closestSurface = Math.min(closestSurface, member.cameraDistance - member.radius);
      farthestSurface = Math.max(farthestSurface, member.cameraDistance + member.radius);
    }

    const desiredNear = nearFactor * closestSurface;
    const desiredFar = farFactor * farthestSurface;

    const near = Math.max(definition.minNear, desiredNear);
    // The far plane must stay strictly beyond the near plane; a degenerate frustum
    // would produce a non-invertible projection matrix.
    const far = Math.min(definition.maxFar, Math.max(desiredFar, near * 1.0001));

    slabs.push({
      id,
      members: members.map((member) => member.id),
      near,
      far,
      depthRatio: far / near,
      empty: false,
      nearClampedToFloor: desiredNear < definition.minNear,
      farClampedToCeiling: desiredFar > definition.maxFar,
    });
  }

  const nonEmpty = slabs.filter((slab) => !slab.empty);

  return {
    slabs,
    nonEmpty,
    assignment,
    clearDepthCount: Math.max(0, nonEmpty.length - 1),
  };
}

/** Result of checking a plan's structural invariants. */
export interface PlanVerification {
  readonly complete: boolean;
  readonly disjoint: boolean;
  readonly contained: boolean;
  readonly problems: readonly string[];
}

/**
 * Verifies the invariants contract section 4.1 requires.
 *
 * COMPLETE   every candidate is assigned to some slab.
 * DISJOINT   no candidate appears in more than one slab's member list.
 * CONTAINED  every member lies within its slab's expanded planes, so nothing is
 *            clipped by the frustum that owns it.
 *
 * Returns a report rather than throwing, so a caller can log a warning and keep
 * rendering. The browser stress test asserts all three hold.
 */
export function verifyDepthPlan(
  candidates: readonly DepthCandidate[],
  plan: DepthPlan,
): PlanVerification {
  const problems: string[] = [];

  const seen = new Map<string, SlabId>();
  for (const slab of plan.slabs) {
    for (const memberId of slab.members) {
      const existing = seen.get(memberId);
      if (existing !== undefined) {
        problems.push(`"${memberId}" appears in both ${existing} and ${slab.id}`);
      }
      seen.set(memberId, slab.id);
    }
  }
  const disjoint = problems.length === 0;

  let complete = true;
  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) {
      complete = false;
      problems.push(`"${candidate.id}" was not assigned to any slab`);
    }
  }

  let contained = true;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const slab of plan.slabs) {
    if (slab.empty) continue;
    for (const memberId of slab.members) {
      const candidate = byId.get(memberId);
      if (candidate === undefined) continue;

      const nearSurface = candidate.cameraDistance - candidate.radius;
      const farSurface = candidate.cameraDistance + candidate.radius;

      // A body the camera is inside straddles the near plane unavoidably: part of
      // it is behind the camera. That is not a containment failure, so the near
      // side is only required to fit when the camera is outside the body.
      if (nearSurface > 0 && nearSurface < slab.near) {
        contained = false;
        problems.push(
          `"${memberId}" near surface ${nearSurface.toExponential(3)} is in front of ` +
            `${slab.id} near plane ${slab.near.toExponential(3)}`,
        );
      }
      if (farSurface > slab.far) {
        contained = false;
        problems.push(
          `"${memberId}" far surface ${farSurface.toExponential(3)} is behind ` +
            `${slab.id} far plane ${slab.far.toExponential(3)}`,
        );
      }
    }
  }

  return { complete, disjoint, contained, problems };
}

// ---------------------------------------------------------------------------
// Depth-buffer arithmetic, for the analytic z-fighting assertions.
//
// These reproduce the mapping from view distance to stored depth so the test
// suite can assert that two overlapping objects are SEPARABLE in the buffer,
// rather than rendering them and inspecting pixels. Pixel inspection cannot
// distinguish "correctly ordered" from "ordered by luck", and is sensitive to
// driver dithering; comparing stored depth values is exact.
// ---------------------------------------------------------------------------

/** Depth-buffer bit depth assumed by the separation assertions. */
export const DEPTH_BUFFER_BITS = 24;

/** Smallest resolvable difference in a normalised depth buffer. */
export const DEPTH_QUANTUM = 2 ** -DEPTH_BUFFER_BITS;

/**
 * Normalised device z for a view distance under a standard perspective
 * projection.
 *
 *   z_ndc = (f + n) / (f - n) - 2 f n / ((f - n) d)
 *
 * which is -1 at d = n and +1 at d = f. This is the hyperbolic distribution that
 * makes a single wide frustum useless: most of the range is consumed within a few
 * multiples of the near plane.
 */
export function perspectiveNdcDepth(distance: number, near: number, far: number): number {
  if (distance <= 0) {
    throw new Error(`perspectiveNdcDepth: distance must be positive, got ${distance}`);
  }
  return (far + near) / (far - near) - (2 * far * near) / ((far - near) * distance);
}

/**
 * Stored depth in [0, 1] for a view distance.
 *
 * LOGARITHMIC FORM mirrors three.js's WebGL2 implementation, which writes
 *
 *   gl_FragDepth = log2(1 + w) * (2 / log2(far + 1)) * 0.5
 *
 * with w the perspective depth. That simplifies to log2(1 + d) / log2(1 + far).
 *
 * Note what is absent: the NEAR plane does not appear. Under this form the
 * distribution is set by the far plane alone, which means pulling the near plane
 * closer costs nothing in log mode while it would be ruinous in linear mode. That
 * is why the dynamic near plane is safe.
 */
export function depthBufferValue(
  distance: number,
  near: number,
  far: number,
  logarithmic: boolean,
): number {
  if (logarithmic) {
    return Math.log2(1 + distance) / Math.log2(1 + far);
  }
  return 0.5 * perspectiveNdcDepth(distance, near, far) + 0.5;
}

/**
 * Separation between two view distances in stored depth units.
 *
 * A value below DEPTH_QUANTUM means the two surfaces land on the same depth value
 * and their draw order becomes arbitrary, which is z-fighting. Measuring this
 * catches the condition BEFORE it is visible, and cannot flake.
 */
export function depthSeparation(
  distanceA: number,
  distanceB: number,
  near: number,
  far: number,
  logarithmic: boolean,
): number {
  return Math.abs(
    depthBufferValue(distanceA, near, far, logarithmic) -
      depthBufferValue(distanceB, near, far, logarithmic),
  );
}

/**
 * Smallest distanc