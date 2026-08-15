/**
 * Layered depth slab validation.
 *
 * WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE RENDER LAYER. The depth
 * architecture is the single item most likely to fail silently: a
 * misclassification does not throw, it makes a planet disappear or flicker, and
 * the symptom appears at a distance from the cause. Every invariant contract
 * section 4.1 states is therefore asserted here, in node, before any GL is
 * involved.
 *
 * TWO REGRESSION GUARDS FOR SPECIFIC ISSUES:
 *
 *   Issue A  the near plane must be dynamic, or a close-orbit camera clips.
 *   Issue B  a body larger than its slab's nominal span must not be cut in half,
 *            which requires expansion rather than reclassification.
 *
 * EXPECTED VALUES are either exact consequences of the documented rule, exact
 * projection identities, or figures measured through the real pipeline and
 * recorded in the module's own header. Nothing astronomical is asserted.
 */

import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_ORDER,
  DEPTH_BUFFER_BITS,
  DEPTH_QUANTUM,
  type DepthCandidate,
  type DepthPlan,
  RENDER_ORDER,
  SLAB_DEFINITIONS,
  type SlabId,
  classifyDepthSlab,
  depthBufferValue,
  depthSeparation,
  perspectiveNdcDepth,
  planDepthSlabs,
  resolvableSeparation,
  slabDefinition,
  verifyDepthPlan,
} from '@/render/depth-slabs';
import { SimulationState } from '@/sim/state';
import { SimulationClock } from '@/core/clock';
import { utc } from '@/core/jd';
import {
  RENDER_UNIT_KM,
  scaleSystem,
  scientificScale,
  visualizedScale,
  type ScaleConfig,
} from '@/sim/scale';
import { getBody } from '@/data/bodies';
import { magnitude, subtract, type Vector3Like } from '@/ephemeris/kepler';
import { DEFAULT_SEED, forEachSample, formatPropertyFailure } from '../helpers/seeded';

/** Render-space radius of the Sun in scientific scale, about 695.7 units. */
const SUN_RADIUS_UNITS = getBody('sun').meanRadiusKm.value / RENDER_UNIT_KM;

/** Convenience constructor. */
function candidate(id: string, cameraDistance: number, radius = 0): DepthCandidate {
  return { id, cameraDistance, radius };
}

describe('slab definitions', () => {
  it('defines exactly three slabs', () => {
    expect(SLAB_DEFINITIONS).toHaveLength(3);
    expect(SLAB_DEFINITIONS.map((definition) => definition.id)).toEqual([
      'NEAR',
      'MIDDLE',
      'FAR',
    ]);
  });

  it('uses the overlapping ranges the contract specifies', () => {
    // The overlap is deliberate and is what makes a documented ownership rule
    // necessary rather than a plain interval test.
    const near = slabDefinition('NEAR');
    const middle = slabDefinition('MIDDLE');
    const far = slabDefinition('FAR');

    expect(near.nominalNear).toBe(1e-1);
    expect(near.nominalFar).toBe(1e4);
    expect(middle.nominalNear).toBe(1e3);
    expect(middle.nominalFar).toBe(1e7);
    expect(far.nominalNear).toBe(1e6);

    // MIDDLE starts inside NEAR, and FAR starts inside MIDDLE.
    expect(middle.nominalNear).toBeLessThan(near.nominalFar);
    expect(far.nominalNear).toBeLessThan(middle.nominalFar);
  });

  it('keeps every near-plane floor positive', () => {
    // A perspective projection is undefined at near = 0, so a floor of zero would
    // produce a non-invertible matrix rather than a very close view.
    for (const definition of SLAB_DEFINITIONS) {
      expect(definition.minNear, `${definition.id}`).toBeGreaterThan(0);
      expect(definition.maxFar, `${definition.id}`).toBeGreaterThan(definition.minNear);
    }
  });

  it('classifies near-first and renders far-first', () => {
    // The two orders are opposites, and both matter: classification order decides
    // ownership in overlap regions, render order decides compositing.
    expect(CLASSIFICATION_ORDER).toEqual(['NEAR', 'MIDDLE', 'FAR']);
    expect(RENDER_ORDER).toEqual(['FAR', 'MIDDLE', 'NEAR']);
    expect([...RENDER_ORDER].reverse()).toEqual([...CLASSIFICATION_ORDER]);
  });

  it('reports an unknown slab id rather than returning undefined', () => {
    expect(() => slabDefinition('OUTER' as SlabId)).toThrow(/unknown slab/);
  });
});

describe('classification rule', () => {
  it('resolves every overlap region to the nearer slab', () => {
    // Rule 3. Precision matters most close to the camera, and the nearer slab has
    // the tighter planes after expansion, so ties must go inward.
    //
    // 1e3 to 1e4 is claimed by both NEAR and MIDDLE; NEAR wins.
    for (const distance of [1e3, 2e3, 5e3, 9999, 1e4]) {
      expect(classifyDepthSlab(distance), `d=${distance}`).toBe('NEAR');
    }

    // 1e6 to 1e7 is claimed by both MIDDLE and FAR; MIDDLE wins.
    for (const distance of [1e6, 5e6, 1e7]) {
      expect(classifyDepthSlab(distance), `d=${distance}`).toBe('MIDDLE');
    }
  });

  it('treats both nominal bounds as inclusive', () => {
    // Rule 2, and the boundary behaviour contract section 4.1 requires to be
    // documented. Measured: 1e4 goes to NEAR, and the very next representable
    // distance goes to MIDDLE.
    expect(classifyDepthSlab(1e4)).toBe('NEAR');
    expect(classifyDepthSlab(1e4 + 1)).toBe('MIDDLE');

    expect(classifyDepthSlab(1e7)).toBe('MIDDLE');
    expect(classifyDepthSlab(1e7 + 1)).toBe('FAR');
  });

  it('owns distances below every nominal near plane with NEAR', () => {
    // Rule 4, and this branch IS reachable: d < 1e-1 units means the camera is
    // within 100 km of a body centre, which happens in close-orbit mode. Without
    // this clause the body would classify nowhere and silently vanish.
    for (const distance of [0, 1e-9, 1e-4, 1e-2, 0.099]) {
      expect(classifyDepthSlab(distance), `d=${distance}`).toBe('NEAR');
    }
  });

  it('owns distances beyond every nominal far plane with FAR', () => {
    // Rule 5.
    for (const distance of [1e13, 1e13 + 1, 1e14, 1e20]) {
      expect(classifyDepthSlab(distance), `d=${distance}`).toBe('FAR');
    }
  });

  it('is total: every non-negative finite distance classifies', () => {
    // The property that makes the function safe to call unconditionally.
    forEachSample(DEFAULT_SEED ^ 0x51ab, 1000, (sampler, context) => {
      const distance = sampler.logRange(1e-12, 1e20);
      const slab = classifyDepthSlab(distance);

      expect(
        CLASSIFICATION_ORDER.includes(slab),
        formatPropertyFailure({ ...context, distance }, 'a valid slab id', slab),
      ).toBe(true);
    });
  });

  it('is monotonic in distance', () => {
    // Ownership must never jump back inward as distance grows, or two objects
    // could be ordered differently by slab than by depth.
    const rank = (slab: SlabId): number => CLASSIFICATION_ORDER.indexOf(slab);

    let previousRank = -1;
    for (let exponent = -6; exponent <= 15; exponent += 0.25) {
      const currentRank = rank(classifyDepthSlab(10 ** exponent));
      expect(
        currentRank,
        `slab rank went backwards at d=1e${exponent}`,
      ).toBeGreaterThanOrEqual(previousRank);
      previousRank = currentRank;
    }
  });

  it('is a pure function of distance, independent of any other object', () => {
    // Classification happens in its own pass precisely so ownership cannot depend
    // on which other bodies are present in the frame.
    const alone = planDepthSlabs([candidate('probe', 5e3, 1)]);
    const crowded = planDepthSlabs([
      candidate('probe', 5e3, 1),
      candidate('a', 1e-2, 0.5),
      candidate('b', 1e6, 100),
      candidate('c', 1e14, 1),
    ]);

    expect(crowded.assignment.get('probe')).toBe(alone.assignment.get('probe'));
  });

  it('rejects a distance it cannot classify', () => {
    expect(() => classifyDepthSlab(-1)).toThrow(/non-negative/);
    expect(() => classifyDepthSlab(Number.NaN)).toThrow(/finite/);
    expect(() => classifyDepthSlab(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe('ISSUE B: a body straddling a nominal boundary', () => {
  /**
   * THE REGRESSION GUARD FOR THE EXPANSION RULE.
   *
   * Contract section 4.1 requires every object in exactly one slab, but its
   * nominal ranges are narrower than some bodies. The Sun is 1391 render units
   * across, so at a centre distance of 1e4 it spans 9304 to 10696 and crosses
   * NEAR's nominal far plane of 1e4 outright.
   *
   * The wrong fixes are to split the object across two slabs, which would draw it
   * twice with a depth clear between the halves, or to reclassify by extent, which
   * would make ownership depend on radius and reintroduce ambiguity. The right fix
   * is to classify by centre and then expand the planes to contain what landed.
   */
  it('classifies the Sun by its centre and expands the planes to fit it', () => {
    const sun = candidate('sun', 1e4, SUN_RADIUS_UNITS);

    // Measured: the Sun spans 9304.3 to 10695.7 units, straddling 1e4.
    expect(sun.cameraDistance - sun.radius).toBeLessThan(1e4);
    expect(sun.cameraDistance + sun.radius).toBeGreaterThan(1e4);

    // Centre distance decides ownership, so NEAR takes it.
    expect(classifyDepthSlab(sun.cameraDistance)).toBe('NEAR');

    const plan = planDepthSlabs([sun]);
    const near = plan.slabs.find((slab) => slab.id === 'NEAR')!;

    // Measured: expanded to 4652.1 .. 21391.4, which contains the whole sphere.
    expect(near.members).toEqual(['sun']);
    expect(near.near).toBeCloseTo(0.5 * (1e4 - SUN_RADIUS_UNITS), 3);
    expect(near.far).toBeCloseTo(2 * (1e4 + SUN_RADIUS_UNITS), 3);

    // The far plane exceeds NEAR's nominal far by more than a factor of two, which
    // is the whole point: nominal ranges classify, they do not clip.
    expect(near.far).toBeGreaterThan(slabDefinition('NEAR').nominalFar * 2);

    expect(verifyDepthPlan([sun], plan).contained).toBe(true);
  });

  it('appears in exactly one slab, never split', () => {
    const sun = candidate('sun', 1e4, SUN_RADIUS_UNITS);
    const plan = planDepthSlabs([sun]);

    const owningSlabs = plan.slabs.filter((slab) => slab.members.includes('sun'));
    expect(owningSlabs).toHaveLength(1);
    expect(plan.assignment.get('sun')).toBe('NEAR');
  });

  it('contains bodies far larger than their slab span', () => {
    // A body whose radius exceeds its own centre distance: the camera is inside it.
    // Part of the sphere is behind the camera and cannot be contained, so the
    // verifier requires only the far side to fit.
    const enclosing = candidate('enclosing', 100, 500);
    const plan = planDepthSlabs([enclosing]);
    const verification = verifyDepthPlan([enclosing], plan);

    expect(verification.contained, verification.problems.join('; ')).toBe(true);

    const owner = plan.slabs.find((slab) => slab.members.includes('enclosing'))!;
    expect(owner.far).toBeGreaterThan(600);
  });
});

describe('ISSUE A: the near plane is dynamic', () => {
  /**
   * Contract section 1.2 fixes one render unit at 1000 km, and section 4.1 gives
   * NEAR a nominal near plane of 1e-1 units, which is 100 km. A static near plane
   * there would clip everything closer than 100 km altitude and make the
   * close-orbit view section 1.4 requires impossible.
   *
   * The near plane is therefore derived per frame from the closest surface, with a
   * floor of 1e-4 units, which is 100 metres.
   */
  it('follows the closest surface rather than sitting at a constant', () => {
    const distant = planDepthSlabs([candidate('body', 500, 10)]);
    const close = planDepthSlabs([candidate('body', 11, 10)]);

    const distantNear = distant.slabs.find((slab) => slab.id === 'NEAR')!.near;
    const closeNear = close.slabs.find((slab) => slab.id === 'NEAR')!.near;

    // Half the distance to the nearest surface in each case.
    expect(distantNear).toBeCloseTo(0.5 * (500 - 10), 6);
    expect(closeNear).toBeCloseTo(0.5 * (11 - 10), 6);
    expect(closeNear).toBeLessThan(distantNear);
  });

  it('permits a camera one kilometre above a surface', () => {
    // 1 km altitude on a body of Earth's radius: centre distance 6372 km, radius
    // 6371 km, so the nearest surface is 0.001 units away.
    const earthRadiusUnits = getBody('earth').meanRadiusKm.value / RENDER_UNIT_KM;
    const oneKilometreUnits = 1 / RENDER_UNIT_KM;

    const plan = planDepthSlabs([
      candidate('earth', earthRadiusUnits + oneKilometreUnits, earthRadiusUnits),
    ]);
    const near = plan.slabs.find((slab) => slab.id === 'NEAR')!;

    // The near plane must be in front of the surface, which a static 1e-1 plane
    // would not be.
    expect(near.near).toBeLessThan(oneKilometreUnits);
    expect(near.near).toBeGreaterThan(0);
    expect(verifyDepthPlan([candidate('earth', earthRadiusUnits + oneKilometreUnits, earthRadiusUnits)], plan).contained).toBe(
      true,
    );
  });

  it('clamps to the floor and reports it when the camera is inside a body', () => {
    // Reachable in close-orbit mode, and certain in scientific mode near the Sun.
    // The desired near plane goes negative, so the floor takes over, and the
    // outcome is reported rather than silently absorbed.
    const inside = candidate('sun', 100, SUN_RADIUS_UNITS);
    const plan = planDepthSlabs([inside]);
    const near = plan.slabs.find((slab) => slab.id === 'NEAR')!;

    expect(inside.cameraDistance - inside.radius).toBeLessThan(0);
    expect(near.near).toBe(slabDefinition('NEAR').minNear);
    expect(near.nearClampedToFloor).toBe(true);
  });

  it('never produces a degenerate or inverted frustum', () => {
    forEachSample(DEFAULT_SEED ^ 0x0a1b, 600, (sampler, context) => {
      const distance = sampler.logRange(1e-6, 1e12);
      const radius = sampler.logRange(1e-6, distance * 3);

      const plan = planDepthSlabs([candidate('body', distance, radius)]);
      const owner = plan.nonEmpty[0]!;

      const valid = owner.near > 0 && owner.far > owner.near && Number.isFinite(owner.far);
      expect(
        valid,
        formatPropertyFailure(
          { ...context, distance, radius },
          'near > 0 and far > near',
          `near=${owner.near}, far=${owner.far}`,
        ),
      ).toBe(true);
    });
  });
});

describe('plane expansion', () => {
  it('applies the documented rule to the extreme members', () => {
    // near = factor * min(d - r), far = factor * max(d + r), over the members that
    // landed in the slab.
    const members = [
      candidate('a', 200, 5),
      candidate('b', 500, 50),
      candidate('c', 300, 1),
    ];
    const plan = planDepthSlabs(members);
    const near = plan.slabs.find((slab) => slab.id === 'NEAR')!;

    expect(near.near).toBeCloseTo(0.5 * (200 - 5), 6);
    expect(near.far).toBeCloseTo(2 * (500 + 50), 6);
  });

  it('honours custom safety factors', () => {
    const members = [candidate('a', 100, 10)];
    const plan = planDepthSlabs(members, { nearSafetyFactor: 0.9, farSafetyFactor: 1 });
    const near = plan.slabs.find((slab) => slab.id === 'NEAR')!;

    expect(near.near).toBeCloseTo(0.9 * 90, 6);
    expect(near.far).toBeCloseTo(110, 6);
  });

  it('rejects safety factors that would clip geometry', () => {
    // A near factor above 1 would push the near plane behind the closest surface,
    // and a far factor below 1 would pull the far plane in front of the farthest.
    expect(() => planDepthSlabs([], { nearSafetyFactor: 1.5 })).toThrow(/\(0, 1\]/);
    expect(() => planDepthSlabs([], { nearSafetyFactor: 0 })).toThrow(/\(0, 1\]/);
    expect(() => planDepthSlabs([], { farSafetyFactor: 0.9 })).toThrow(/at least 1/);
  });

  it('clamps the far plane to the slab ceiling and reports it', () => {
    const remote = candidate('remote', 1e13, 1e13);
    const plan = planDepthSlabs([remote]);
    const far = plan.slabs.find((slab) => slab.id === 'FAR')!;

    expect(far.far).toBe(slabDefinition('FAR').maxFar);
    expect(far.farClampedToCeiling).toBe(true);
  });

  it('leaves an empty slab with zeroed planes rather than stale ones', () => {
    const plan = planDepthSlabs([candidate('near-body', 5, 1)]);

    for (const slab of plan.slabs) {
      if (slab.id === 'NEAR') continue;
      expect(slab.empty, `${slab.id}`).toBe(true);
      expect(slab.near, `${slab.id}`).toBe(0);
      expect(slab.far, `${slab.id}`).toBe(0);
      expect(slab.depthRatio, `${slab.id}`).toBe(1);
      expect(slab.members, `${slab.id}`).toEqual([]);
    }
  });

  it('reports a depth ratio consistent with its planes', () => {
    const plan = planDepthSlabs([candidate('a', 1000, 10), candidate('b', 1e6, 100)]);
    for (const slab of plan.nonEmpty) {
      expect(slab.depthRatio, `${slab.id}`).toBeCloseTo(slab.far / slab.near, 9);
    }
  });
});

describe('plan structure', () => {
  it('returns every slab in render order', () => {
    const plan = planDepthSlabs([candidate('a', 5, 1)]);
    expect(plan.slabs.map((slab) => slab.id)).toEqual([...RENDER_ORDER]);
  });

  it('lists only occupied slabs in nonEmpty, still in render order', () => {
    const plan = planDepthSlabs([candidate('a', 5, 1), candidate('b', 1e6, 10)]);
    expect(plan.nonEmpty.map((slab) => slab.id)).toEqual(['MIDDLE', 'NEAR']);
  });

  it('needs one fewer depth clear than it has occupied slabs', () => {
    // Contract section 4.2: the first slab renders into an already-cleared buffer,
    // and empty slabs are skipped so they cost nothing.
    expect(planDepthSlabs([]).clearDepthCount).toBe(0);
    expect(planDepthSlabs([candidate('a', 5, 1)]).clearDepthCount).toBe(0);
    expect(
      planDepthSlabs([candidate('a', 5, 1), candidate('b', 1e6, 1)]).clearDepthCount,
    ).toBe(1);
    expect(
      planDepthSlabs([
        candidate('a', 5, 1),
        candidate('b', 1e6, 1),
        candidate('c', 1e12, 1),
      ]).clearDepthCount,
    ).toBe(2);
  });

  it('preserves the order candidates were supplied in', () => {
    // Draw order within a slab follows submission order, so it must be stable.
    const plan = planDepthSlabs([
      candidate('third', 300, 1),
      candidate('first', 100, 1),
      candidate('second', 200, 1),
    ]);
    expect(plan.slabs.find((slab) => slab.id === 'NEAR')!.members).toEqual([
      'third',
      'first',
      'second',
    ]);
  });

  it('handles an empty frame without throwing', () => {
    const plan = planDepthSlabs([]);
    expect(plan.nonEmpty).toEqual([]);
    expect(plan.assignment.size).toBe(0);
    expect(verifyDepthPlan([], plan).complete).toBe(true);
  });

  it('rejects a duplicate id rather than producing a lossy assignment', () => {
    // The assignment map is keyed by id, so a duplicate would silently drop one
    // object and break the partition property the stress test relies on.
    expect(() =>
      planDepthSlabs([candidate('earth', 5, 1), candidate('earth', 1e6, 1)]),
    ).toThrow(/duplicate candidate id/);
  });

  it('rejects an invalid radius', () => {
    expect(() => planDepthSlabs([candidate('a', 100, -1)])).toThrow(/invalid radius/);
    expect(() => planDepthSlabs([candidate('a', 100, Number.NaN)])).toThrow(/invalid radius/);
  });
});

describe('partition invariants', () => {
  it('assigns every candidate exactly once, for arbitrary scenes', () => {
    // CONTRACT SECTION 4.1, as a property rather than a fixture. Complete and
    // disjoint must hold for any set of objects at any distances.
    forEachSample(DEFAULT_SEED ^ 0x9a8b, 400, (sampler, context) => {
      const count = sampler.int(1, 25);
      const candidates: DepthCandidate[] = [];

      for (let index = 0; index < count; index++) {
        const distance = sampler.logRange(1e-6, 1e15);
        candidates.push(
          candidate(`body-${index}`, distance, sampler.logRange(1e-9, distance * 0.5)),
        );
      }

      const plan = planDepthSlabs(candidates);
      const verification = verifyDepthPlan(candidates, plan);

      expect(
        verification.complete && verification.disjoint && verification.contained,
        formatPropertyFailure(
          { ...context, count },
          'complete, disjoint and contained',
          verification.problems.join('; ') || 'unknown failure',
        ),
      ).toBe(true);

      // The assignment map must agree with the member lists.
      expect(plan.assignment.size).toBe(count);
      const fromMembers = plan.slabs.flatMap((slab) => slab.members);
      expect(fromMembers).toHaveLength(count);
      expect(new Set(fromMembers).size).toBe(count);
    });
  });

  it('agrees between the assignment map and the member lists', () => {
    const candidates = [
      candidate('a', 1e-3, 1e-4),
      candidate('b', 5e3, 10),
      candidate('c', 5e6, 100),
      candidate('d', 5e13, 1000),
    ];
    const plan = planDepthSlabs(candidates);

    for (const slab of plan.slabs) {
      for (const memberId of slab.members) {
        expect(plan.assignment.get(memberId), `${memberId}`).toBe(slab.id);
      }
    }
  });
});

describe('plan verification', () => {
  it('detects an unassigned candidate', () => {
    // The verifier must be capable of failing, or it proves nothing. A hand-built
    // plan is used because planDepthSlabs never produces an invalid one.
    const candidates = [candidate('present', 100, 1), candidate('missing', 200, 1)];
    const broken: DepthPlan = {
      slabs: [
        {
          id: 'NEAR',
          members: ['present'],
          near: 1,
          far: 1000,
          depthRatio: 1000,
          empty: false,
          nearClampedToFloor: false,
          farClampedToCeiling: false,
        },
      ],
      nonEmpty: [],
      assignment: new Map([['present', 'NEAR']]),
      clearDepthCount: 0,
    };

    const verification = verifyDepthPlan(candidates, broken);
    expect(verification.complete).toBe(false);
    expect(verification.problems.some((problem) => problem.includes('missing'))).toBe(true);
  });

  it('detects a candidate claimed by two slabs', () => {
    const candidates = [candidate('shared', 100, 1)];
    const slabTemplate = {
      members: ['shared'],
      near: 1,
      far: 1000,
      depthRatio: 1000,
      empty: false as const,
      nearClampedToFloor: false,
      farClampedToCeiling: false,
    };
    const broken: DepthPlan = {
      slabs: [
        { id: 'NEAR', ...slabTemplate },
        { id: 'MIDDLE', ...slabTemplate },
      ],
      nonEmpty: [],
      assignment: new Map([['shared', 'NEAR']]),
      clearDepthCount: 0,
    };

    const verification = verifyDepthPlan(candidates, broken);
    expect(verification.disjoint).toBe(false);
    expect(verification.problems.some((problem) => problem.includes('appears in both'))).toBe(
      true,
    );
  });

  it('detects geometry clipped by its own slab planes', () => {
    const candidates = [candidate('clipped', 500, 100)];
    const broken: DepthPlan = {
      slabs: [
        {
          id: 'NEAR',
          members: ['clipped'],
          // Planes deliberately too tight: the body spans 400 to 600.
          near: 450,
          far: 550,
          depthRatio: 550 / 450,
          empty: false,
          nearClampedToFloor: false,
          farClampedToCeiling: false,
        },
      ],
      nonEmpty: [],
      assignment: new Map([['clipped', 'NEAR']]),
      clearDepthCount: 0,
    };

    const verification = verifyDepthPlan(candidates, broken);
    expect(verification.contained).toBe(false);
    expect(verification.problems.some((problem) => problem.includes('near surface'))).toBe(true);
    expect(verification.problems.some((problem) => problem.includes('far surface'))).toBe(true);
  });

  it('accepts every plan the planner actually produces', () => {
    for (const scene of [
      [candidate('a', 1e-4, 1e-5)],
      [candidate('a', 1e4, SUN_RADIUS_UNITS)],
      [candidate('a', 5, 1), candidate('b', 5e6, 25), candidate('c', 5e13, 1e3)],
      [candidate('inside', 10, 100)],
    ]) {
      const verification = verifyDepthPlan(scene, planDepthSlabs(scene));
      expect(
        verification.complete && verification.disjoint && verification.contained,
        verification.problems.join('; '),
      ).toBe(true);
    }
  });
});

describe('depth-buffer arithmetic', () => {
  it('maps the near and far planes to the ends of the NDC range', () => {
    // Exact projection identities, independent of the values chosen.
    const near = 0.5;
    const far = 1000;
    expect(perspectiveNdcDepth(near, near, far)).toBeCloseTo(-1, 9);
    expect(perspectiveNdcDepth(far, near, far)).toBeCloseTo(1, 9);
  });

  it('maps linear stored depth onto [0, 1]', () => {
    const near = 1;
    const far = 1e4;
    expect(depthBufferValue(near, near, far, false)).toBeCloseTo(0, 9);
    expect(depthBufferValue(far, near, far, false)).toBeCloseTo(1, 9);
  });

  it('is monotonically increasing in distance under both schemes', () => {
    // A non-monotonic depth mapping would order surfaces wrongly.
    const near = 0.5;
    const far = 1e6;
    for (const logarithmic of [false, true]) {
      let previous = -Infinity;
      for (let exponent = 0; exponent <= 6; exponent += 0.1) {
        const value = depthBufferValue(10 ** exponent, near, far, logarithmic);
        expect(value, `log=${logarithmic} at 1e${exponent}`).toBeGreaterThan(previous);
        previous = value;
      }
    }
  });

  it('leaves the logarithmic form independent of the near plane', () => {
    // A real property of three.js's implementation, and the reason a very close
    // near plane costs nothing in log mode. Pulling the near plane in by four
    // orders of magnitude must not change any stored depth.
    const far = 1e6;
    for (const distance of [1, 100, 1e4, 1e6]) {
      expect(
        depthBufferValue(distance, 1e-4, far, true),
        `d=${distance}`,
      ).toBeCloseTo(depthBufferValue(distance, 1, far, true), 12);
    }
  });

  it('agrees with the documented quantum', () => {
    expect(DEPTH_BUFFER_BITS).toBe(24);
    expect(DEPTH_QUANTUM).toBe(2 ** -24);
  });

  it('reports zero separation for identical distances', () => {
    expect(depthSeparation(500, 500, 1, 1e4, false)).toBe(0);
    expect(depthSeparation(500, 500, 1, 1e4, true)).toBe(0);
  });

  it('derives a resolvable separation that really moves the buffer by one quantum', () => {
    // SELF-CONSISTENCY CHECK on the analytic derivative. Stepping by the reported
    // resolvable separation must change stored depth by about one quantum, which
    // validates the calculus rather than trusting it.
    const near = 0.5;
    const far = 1e6;

    for (const logarithmic of [false, true]) {
      for (const distance of [1, 10, 1e3, 1e5]) {
        const step = resolvableSeparation(distance, near, far, logarithmic);
        const measured = depthSeparation(distance, distance + step, near, far, logarithmic);

        // Within a factor of two of one quantum: the derivative is local, and a
        // finite step over a nonlinear mapping cannot match it exactly.
        expect(
          measured / DEPTH_QUANTUM,
          `log=${logarithmic} at d=${distance}`,
        ).toBeGreaterThan(0.5);
        expect(
          measured / DEPTH_QUANTUM,
          `log=${logarithmic} at d=${distance}`,
        ).toBeLessThan(2);
      }
    }
  });

  it('degrades logarithmic resolution linearly with distance', () => {
    // The property that makes log depth suitable for astronomical scenes: doubling
    // the distance roughly doubles the resolvable separation, rather than squaring
    // it as linear depth does.
    const far = 1e7;
    const atNear = resolvableSeparation(1e3, 1, far, true);
    const atFar = resolvableSeparation(2e3, 1, far, true);
    expect(atFar / atNear).toBeCloseTo(2, 1);
  });

  it('degrades linear resolution quadratically with distance', () => {
    const near = 1;
    const far = 1e7;
    const atNear = resolvableSeparation(1e3, near, far, false);
    const atFar = resolvableSeparation(2e3, near, far, false);
    expect(atFar / atNear).toBeCloseTo(4, 1);
  });

  it('rejects a non-positive distance', () => {
    expect(() => perspectiveNdcDepth(0, 1, 100)).toThrow(/positive/);
    expect(() => perspectiveNdcDepth(-5, 1, 100)).toThrow(/positive/);
  });
});

describe('the Moon-close plus Neptune-visible stress scene', () => {
  /**
   * The scene contract section 6 makes a hard M1 gate, exercised here in node
   * against the real simulation, scale transform and planner. The browser suite
   * then renders the same configuration; this establishes that the geometry and
   * classification are right before any GL is involved.
   */
  interface StressScene {
    readonly candidates: readonly DepthCandidate[];
    readonly plan: DepthPlan;
    readonly camera: Vector3Like;
    readonly moonStandoff: number;
  }

  function buildScene(config: ScaleConfig): StressScene {
    const state = new SimulationState({
      clock: new SimulationClock({ epoch: utc(2026, 8, 15), paused: true }),
    });
    const snapshot = state.snapshot();

    const scaled = scaleSystem(
      snapshot.bodies.map((body) => ({
        bodyId: body.bodyId,
        positionKm: body.positionKm,
        parentId: body.parentId,
        physicalRadiusKm: body.physicalRadiusKm,
      })),
      config,
    );

    // No lunar theory in M1, so the Moon is synthesised at Earth plus its mean
    // orbital radius. The stress scene needs a near body; where exactly it sits in
    // its orbit is irrelevant to depth classification.
    const earth = scaled.find((body) => body.bodyId === 'earth')!;
    const moonMultiplier = config.mode === 'VISUALIZED' ? config.radiusMultiplier : 1;
    const moonRadius = (getBody('moon').meanRadiusKm.value * moonMultiplier) / RENDER_UNIT_KM;
    const moonPosition: Vector3Like = {
      x: earth.renderPosition.x + 384_400 / RENDER_UNIT_KM,
      y: earth.renderPosition.y,
      z: earth.renderPosition.z,
    };

    // Camera 1000 km above the lunar surface.
    const moonStandoff = moonRadius + 1000 / RENDER_UNIT_KM;
    const camera: Vector3Like = {
      x: moonPosition.x + moonStandoff,
      y: moonPosition.y,
      z: moonPosition.z,
    };

    const candidates: DepthCandidate[] = scaled.map((body) => ({
      id: body.bodyId,
      cameraDistance: magnitude(subtract(body.renderPosition, camera)),
      radius: body.visualRadius,
    }));
    candidates.push({ id: 'moon', cameraDistance: moonStandoff, radius: moonRadius });

    return { candidates, plan: planDepthSlabs(candidates), camera, moonStandoff };
  }

  for (const config of [scientificScale(), visualizedScale()]) {
    describe(`${config.mode} scale`, () => {
      const scene = buildScene(config);

      it('satisfies every partition invariant', () => {
        const verification = verifyDepthPlan(scene.candidates, scene.plan);
        expect(verification.complete, verification.problems.join('; ')).toBe(true);
        expect(verification.disjoint, verification.problems.join('; ')).toBe(true);
        expect(verification.contained, verification.problems.join('; ')).toBe(true);
      });

      it('places the Moon and Earth in NEAR and the rest in MIDDLE', () => {
        // Measured through the real pipeline in both scale modes.
        expect(scene.plan.assignment.get('moon')).toBe('NEAR');
        expect(scene.plan.assignment.get('earth')).toBe('NEAR');

        for (const bodyId of ['sun', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
          expect(scene.plan.assignment.get(bodyId), bodyId).toBe('MIDDLE');
        }
      });

      it('uses two slabs and one depth clear', () => {
        // The FAR slab is unused by solar-system scenes: MIDDLE's nominal range
        // reaches 1e7 units, which is 67 au, so Neptune at 4.4e6 falls inside it.
        // Recorded so the empty slab is understood rather than taken for a bug.
        expect(scene.plan.nonEmpty.map((slab) => slab.id)).toEqual(['MIDDLE', 'NEAR']);
        expect(scene.plan.clearDepthCount).toBe(1);
        expect(scene.plan.slabs.find((slab) => slab.id === 'FAR')!.empty).toBe(true);
      });

      it('keeps Neptune visible rather than beyond the far plane', () => {
        // The specific failure contract section 6 names: Neptune must not disappear.
        const neptune = scene.candidates.find((entry) => entry.id === 'neptune')!;
        const owner = scene.plan.slabs.find((slab) => slab.members.includes('neptune'))!;

        expect(neptune.cameraDistance + neptune.radius).toBeLessThan(owner.far);
        expect(neptune.cameraDistance - neptune.radius).toBeGreaterThan(owner.near);
      });

      it('keeps the Moon in front of the near plane rather than clipped', () => {
        const moon = scene.candidates.find((entry) => entry.id === 'moon')!;
        const owner = scene.plan.slabs.find((slab) => slab.members.includes('moon'))!;

        expect(moon.cameraDistance - moon.radius).toBeGreaterThan(owner.near);
        // And the near plane is far tighter than the nominal 1e-1 a static plane
        // would impose, which is Issue A in the real scene.
        expect(owner.near).toBeLessThan(slabDefinition('NEAR').nominalNear * 10);
      });

      it('bounds every slab depth ratio well below a single-frustum span', () => {
        // A single frustum covering this scene would span about 5e10. Measured slab
        // ratios are 1.6e3 for NEAR and 1.7e2 for MIDDLE in scientific scale.
        for (const slab of scene.plan.nonEmpty) {
          expect(slab.depthRatio, `${slab.id}`).toBeLessThan(1e5);
          expect(slab.depthRatio, `${slab.id}`).toBeGreaterThan(1);
        }
      });

      it('resolves every body to well within its own radius', () => {
        // THE ASSERTION THAT MEANS "NO Z-FIGHTING". A body whose depth resolution
        // is coarser than its own radius cannot be depth-sorted against itself, and
        // its surface would flicker.
        for (const slab of scene.plan.nonEmpty) {
          for (const memberId of slab.members) {
            const member = scene.candidates.find((entry) => entry.id === memberId)!;
            if (member.radius === 0) continue;

            const resolution = resolvableSeparation(
              member.cameraDistance,
              slab.near,
              slab.far,
              true,
            );
            expect(
              resolution / member.radius,
              `${memberId}: resolves ${resolution.toExponential(3)} against radius ${member.radius.toExponential(3)}`,
            ).toBeLessThan(0.5);
          }
        }
      });
    });
  }

  it('shows logarithmic depth outperforming linear at the worst case', () => {
    // THE MEASUREMENT THAT JUSTIFIES ENABLING LOG DEPTH, and which corrected an
    // earlier claim in this module that log depth was a net loss.
    //
    // Within a slab the two schemes trade places, so the choice must be decided by
    // the worst case rather than the average. That worst case is Neptune.
    const scene = buildScene(scientificScale());
    const neptune = scene.candidates.find((entry) => entry.id === 'neptune')!;
    const slab = scene.plan.slabs.find((entry) => entry.members.includes('neptune'))!;

    const linear = resolvableSeparation(neptune.cameraDistance, slab.near, slab.far, false);
    const logarithmic = resolvableSeparation(neptune.cameraDistance, slab.near, slab.far, true);

    // Measured: linear 21760 km, log 4148 km, against Neptune's radius of 24622 km.
    expect(logarithmic).toBeLessThan(linear);
    expect(linear / logarithmic).toBeGreaterThan(4);

    // Linear resolution is comparable to Neptune's own radius, which would artefact.
    expect(linear / neptune.radius).toBeGreaterThan(0.5);
    // Log resolution is comfortably finer.
    expect(logarithmic / neptune.radius).toBeLessThan(0.25);
  });
});
