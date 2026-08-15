/**
 * Star field.
 *
 * NOT A STAR CATALOGUE. Every star drawn by this module is generated from a seeded
 * pseudo-random distribution. No position, brightness or colour here corresponds to
 * a real star, and the interface must label the field as a STATISTICAL DISTRIBUTION
 * exactly as contract section 18 requires for the asteroid belt. The same principle
 * applies for the same reason: presenting synthesised objects as observed ones is
 * the fabrication the project contract forbids, whether the objects are asteroids or
 * stars.
 *
 * A real catalogue is a clean future substitution. Hipparcos or the Yale Bright Star
 * Catalogue would supply right ascension, declination, visual magnitude and colour
 * index for a few thousand stars, which is the same shape of data this module
 * generates. The generator is therefore isolated behind generateStars so a catalogue
 * loader can replace it without touching the rendering.
 *
 * STARS ARE LOCKED TO THE CAMERA POSITION, and that is physically correct rather
 * than a shortcut. Parallax is the measure of how much a star shifts as the observer
 * moves, and the nearest star sits about 1.3 parsecs away, which by the definition of
 * the parsec means a shift of roughly 0.77 arcseconds across a one astronomical unit
 * baseline. Even a camera traversing Neptune's orbit, a 30 au baseline, moves it by
 * about 23 arcseconds. At a 45 degree vertical field of view rendered to 1080 pixels,
 * one pixel spans about 150 arcseconds. The largest possible parallax in this
 * application is therefore about 0.15 pixels, so translating the star field with the
 * camera would be indistinguishable from locking it, and locking it avoids any
 * precision question at astronomical radii.
 *
 * ROTATION IS NOT LOCKED. Turning the camera must sweep the star field, since that is
 * how orientation is perceived. So the star camera shares the field of view, aspect
 * ratio and orientation of the slab cameras, and differs in having no position.
 *
 * NO MILKY WAY, NO NEBULAE. The distribution is uniform over the sphere. The real sky
 * is not uniform, and a galactic band would be more faithful, but rendering one
 * convincingly means either a real catalogue or a decorative texture. The project
 * brief explicitly rules out nebula wallpaper, and a hand-painted band would be
 * exactly that. Its absence is a deliberate omission rather than an oversight.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  PerspectiveCamera,
  Points,
  type Scene,
  ShaderMaterial,
  type WebGLRenderer,
} from 'three';
import type { SharedCameraState } from './layered-cameras';
import { STARFIELD_LAYER } from './layers';

/**
 * Number of stars generated.
 *
 * A presentation parameter. About six thousand stars are visible to the unaided eye
 * across the whole sky under ideal conditions, so this figure is in the right region
 * without claiming to reproduce that count.
 */
export const DEFAULT_STAR_COUNT = 6000;

/** Default seed. Fixed so the field is identical between sessions. */
export const DEFAULT_STAR_SEED = 0x51a45eed;

/**
 * Faintest and brightest synthetic magnitudes.
 *
 * Presentation parameters chosen to give a plausible spread of apparent brightness.
 * They are not a statement about the real magnitude limit of any instrument.
 */
const FAINTEST_MAGNITUDE = 6.5;
const BRIGHTEST_MAGNITUDE = -1.0;

/**
 * Exponent of the magnitude distribution.
 *
 * Star counts rise steeply with magnitude, so a uniform draw would produce a sky of
 * uniformly bright stars, which reads as artificial. Drawing magnitude as
 * faintest - range * u^exponent with an exponent above one biases towards the faint
 * end, giving many dim stars and few bright ones. The value is tuned by eye and
 * carries no empirical claim.
 */
const MAGNITUDE_DISTRIBUTION_EXPONENT = 2.4;

/**
 * Approximate colours for stellar temperature classes, warm to cool.
 *
 * PRESENTATION PARAMETERS, NOT MEASURED COLOUR. A faithful rendering would integrate
 * a Planck spectrum against a colour matching function, which needs colorimetric data
 * this project does not carry. These are approximate visual renderings of the
 * familiar sequence from hot blue-white through white and yellow to cool orange-red,
 * and they are stored here beside the renderer rather than in src/data precisely
 * because they assert nothing about the physical world.
 */
const TEMPERATURE_COLOURS: readonly (readonly [number, number, number])[] = [
  [0.62, 0.72, 1.0],
  [0.79, 0.85, 1.0],
  [0.93, 0.95, 1.0],
  [1.0, 1.0, 0.97],
  [1.0, 0.96, 0.84],
  [1.0, 0.87, 0.68],
  [1.0, 0.74, 0.53],
];

/**
 * Radius of the sphere the stars are placed on, render units.
 *
 * Arbitrary, because the star camera has its own near and far planes chosen around
 * it and the pass writes no depth. It exists only so the positions are finite.
 */
const STAR_SPHERE_RADIUS = 1;

/** One synthetic star. */
export interface SyntheticStar {
  /** Unit direction in the simulation's ecliptic frame. */
  readonly direction: readonly [number, number, number];
  /** Synthetic visual magnitude. Lower is brighter. */
  readonly magnitude: number;
  /** Linear RGB, each component in [0, 1]. */
  readonly colour: readonly [number, number, number];
}

/**
 * SplitMix32.
 *
 * The same algorithm the test helper uses, reimplemented here because the render
 * layer must not import from the test tree. Chosen for being a handful of integer
 * operations with no dependencies and no reliance on Math.random, so the field is
 * byte-identical between runs and cannot shimmer between frames.
 */
function createGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x9e37_79b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 0x1_0000_0000;
  };
}

/**
 * Generates the synthetic star field.
 *
 * DIRECTIONS ARE UNIFORM OVER THE SPHERE, using the method that samples z uniformly
 * and azimuth uniformly. That is uniform by Archimedes' theorem, whereas sampling
 * both spherical angles uniformly would concentrate stars at the poles, which is a
 * common and very visible error.
 *
 * Isolated from the rendering so a real catalogue can replace it wholesale.
 */
export function generateStars(
  count: number = DEFAULT_STAR_COUNT,
  seed: number = DEFAULT_STAR_SEED,
): readonly SyntheticStar[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`generateStars: count must be a non-negative integer, got ${count}`);
  }

  const random = createGenerator(seed);
  const stars: SyntheticStar[] = [];

  for (let index = 0; index < count; index++) {
    // Uniform on the sphere: z uniform in [-1, 1], azimuth uniform in [0, 2pi).
    const z = random() * 2 - 1;
    const azimuth = random() * 2 * Math.PI;
    const planarRadius = Math.sqrt(Math.max(0, 1 - z * z));

    const magnitude =
      FAINTEST_MAGNITUDE -
      (FAINTEST_MAGNITUDE - BRIGHTEST_MAGNITUDE) *
        random() ** MAGNITUDE_DISTRIBUTION_EXPONENT;

    const colourIndex = Math.min(
      TEMPERATURE_COLOURS.length - 1,
      Math.floor(random() * TEMPERATURE_COLOURS.length),
    );

    stars.push({
      direction: [planarRadius * Math.cos(azimuth), planarRadius * Math.sin(azimuth), z],
      magnitude,
      colour: TEMPERATURE_COLOURS[colourIndex]!,
    });
  }

  return stars;
}

/**
 * Converts a magnitude to a relative linear brightness.
 *
 * The magnitude scale is logarithmic and inverted: five magnitudes is a factor of one
 * hundred in flux, so brightness is 10^(-0.4 * (m - reference)). That relation is
 * definitional rather than empirical, which is why it is applied directly here
 * instead of being approximated.
 */
function brightnessFromMagnitude(magnitude: number): number {
  return 10 ** (-0.4 * (magnitude - FAINTEST_MAGNITUDE));
}

export interface StarfieldOptions {
  readonly count?: number;
  readonly seed?: number;
  /**
   * Overall brightness multiplier.
   *
   * The brief requires the star field to remain visually subordinate to the planets,
   * so the default is deliberately low.
   */
  readonly intensity?: number;
}

/** Default overall intensity. A presentation parameter. */
export const DEFAULT_STAR_INTENSITY = 0.55;

/**
 * The star field pass.
 *
 * Owns its own camera, because it needs the shared orientation and field of view but
 * no position and its own trivial depth range. Attempting to reuse a slab camera
 * would either move the stars with the camera or force the slab planes to accommodate
 * the star sphere.
 */
export class Starfield {
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly points: Points;
  private readonly camera: PerspectiveCamera;
  private readonly starCount: number;

  constructor(
    private readonly scene: Scene,
    options: StarfieldOptions = {},
  ) {
    const stars = generateStars(options.count ?? DEFAULT_STAR_COUNT, options.seed ?? DEFAULT_STAR_SEED);
    this.starCount = stars.length;

    const positions = new Float32Array(this.starCount * 3);
    const brightness = new Float32Array(this.starCount);
    const colours = new Float32Array(this.starCount * 3);

    for (const [index, star] of stars.entries()) {
      positions[index * 3] = star.direction[0] * STAR_SPHERE_RADIUS;
      positions[index * 3 + 1] = star.direction[1] * STAR_SPHERE_RADIUS;
      positions[index * 3 + 2] = star.direction[2] * STAR_SPHERE_RADIUS;

      brightness[index] = brightnessFromMagnitude(star.magnitude);

      colours[index * 3] = star.colour[0];
      colours[index * 3 + 1] = star.colour[1];
      colours[index * 3 + 2] = star.colour[2];
    }

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.geometry.setAttribute('starBrightness', new BufferAttribute(brightness, 1));
    this.geometry.setAttribute('starColour', new BufferAttribute(colours, 3));

    this.material = new ShaderMaterial({
      transparent: true,
      // NO DEPTH INTERACTION AT ALL. Stars are infinitely distant, so they must never
      // occlude anything and must never be occluded within their own pass. Writing
      // depth would also leave values in the buffer that the first slab's depth clear
      // would have to remove.
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uIntensity: { value: options.intensity ?? DEFAULT_STAR_INTENSITY },
      },
      vertexShader: STAR_VERTEX_SHADER,
      fragmentShader: STAR_FRAGMENT_SHADER,
    });

    this.points = new Points(this.geometry, this.material);
    // Positions are fixed and the camera sits at the centre of the sphere, so every
    // star is always in front of the camera and culling can only cost time.
    this.points.frustumCulled = false;
    this.points.name = 'starfield';
    this.points.layers.set(STARFIELD_LAYER);
    scene.add(this.points);

    // Near and far bracket the star sphere with room to spare. The values are
    // irrelevant to compositing because the pass writes no depth; they exist only to
    // give a valid projection.
    this.camera = new PerspectiveCamera(45, 1, STAR_SPHERE_RADIUS * 0.1, STAR_SPHERE_RADIUS * 10);
    this.camera.matrixAutoUpdate = false;
    this.camera.layers.set(STARFIELD_LAYER);
  }

  /** Number of stars generated. */
  get count(): number {
    return this.starCount;
  }

  /** The points object, for tests and diagnostics. */
  get object(): Points {
    return this.points;
  }

  /**
   * Syncs the star camera to the shared camera state.
   *
   * Copies field of view, aspect ratio and orientation. Deliberately does NOT copy
   * position: the camera stays at the centre of the star sphere so translation has no
   * effect, which is what makes the stars behave as though infinitely distant.
   */
  update(shared: SharedCameraState): void {
    this.camera.fov = shared.fovDeg;
    this.camera.aspect = shared.aspect;
    this.camera.quaternion.copy(shared.quaternion);

    // Rotation only. The matrix is composed by hand because matrixAutoUpdate is off.
    this.camera.matrix.makeRotationFromQuaternion(this.camera.quaternion);
    this.camera.matrixWorld.copy(this.camera.matrix);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();

    this.camera.updateProjectionMatrix();
  }

  /**
   * Renders the star field.
   *
   * MUST RUN FIRST, before any slab, per contract section 4.2's ordering. Because the
   * pass neither tests nor writes depth, running it later would paint stars over
   * planets.
   *
   * Does not clear. The frame's single colour clear is the caller's responsibility, so
   * that ownership of clearing lives in one place.
   */
  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  /** The star camera, for tests and diagnostics. */
  get starCamera(): PerspectiveCamera {
    return this.camera;
  }

  /** Sets the overall brightness. */
  setIntensity(intensity: number): void {
    if (!Number.isFinite(intensity) || intensity < 0) {
      throw new Error(`Starfield.setIntensity: intensity must be finite and non-negative, got ${intensity}`);
    }
    this.material.uniforms['uIntensity']!.value = intensity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
  }
}

/**
 * Star vertex shader.
 *
 * Point size varies with brightness so bright stars read as larger, which is how the
 * eye and every optical system perceive them. Size is in pixels and independent of
 * distance, which is correct for objects at effectively infinite range.
 */
const STAR_VERTEX_SHADER = /* glsl */ `
  attribute float starBrightness;
  attribute vec3 starColour;

  uniform float uIntensity;

  varying vec3 vColour;
  varying float vBrightness;

  void main() {
    vColour = starColour;
    vBrightness = starBrightness * uIntensity;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    // Bright stars are drawn slightly larger. The fourth root compresses a wide
    // brightness range into a narrow size range, so the faintest stars stay a single
    // point and the brightest do not become discs.
    gl_PointSize = 1.0 + 2.2 * pow(clamp(starBrightness, 0.0, 1.0), 0.25);
  }
`;

/**
 * Star fragment shader.
 *
 * A soft radial profile rather than a hard square, so stars read as points of light.
 * The brief calls for no excessive lens effects, so there is no diffraction spike, no
 * halo and no bloom contribution from this pass.
 */
const STAR_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColour;
  varying float vBrightness;

  void main() {
    vec2 offset = gl_PointCoord - vec2(0.5);
    float radius = length(offset) * 2.0;
    if (radius > 1.0) discard;

    float falloff = pow(1.0 - radius, 2.0);
    gl_FragColor = vec4(vColour * vBrightness * falloff, 1.0);
  }
`;

/**
 * Provenance for the interface.
 *
 * Contract sections 11 and 27 govern the vocabulary: this is a MODEL, and specifically
 * a statistical one, so it must never be labelled as observed or catalogued data.
 */
export const STARFIELD_PROVENANCE = {
  model: 'Synthetic uniform star distribution',
  status: 'STATISTICAL DISTRIBUTION' as const,
  note:
    'Procedurally generated. Not a star catalogue: no star shown corresponds to a real star. ' +
    'Positions are uniform over the sphere, so the galactic plane is deliberately absent.',
  futureSource: 'Hipparcos or Yale Bright Star Catalogue',
} as const;
