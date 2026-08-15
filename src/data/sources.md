# Data provenance

Every astronomical constant in this project traces to a citation below. No value
in `src/data/` was invented, estimated, or copied from an uncited secondary
source. Where a value is derived rather than quoted, the derivation is stated.

Field-level sources are declared once per field in a `FIELD_SOURCES` registry
beside each table, rather than repeated on every value. §12 of the project
contract permits this schema-level form, and it keeps the tables readable.

Retrieved 2026-08-15.

---

## S1 — JPL SSD, Approximate Positions of the Planets

**URL:** https://ssd.jpl.nasa.gov/planets/approx_pos.html
**Origin:** E. M. Standish & J. G. Williams (1992), republished by JPL Solar
System Dynamics with the author's permission.
**Used for:** `src/data/jpl-elements.ts` — Keplerian elements and per-century
rates, the Table 2b augmentation terms, the Kepler-solver formulation, and the
ecliptic-to-equatorial obliquity used by that transformation.

Two element sets are published:

| Set | Interval | Notes |
| --- | --- | --- |
| Table 1 | 1800 AD – 2050 AD | Default. No augmentation terms. |
| Table 2a | 3000 BC – 3000 AD | Jupiter–Neptune **require** the Table 2b terms. |

Nominal accuracy, Table 1 (from the source page):

| Body | λ (″) | φ (″) | ρ (1000 km) |
| --- | --- | --- | --- |
| Mercury | 15 | 1 | 1 |
| Venus | 20 | 1 | 4 |
| EM Bary | 20 | 8 | 6 |
| Mars | 40 | 2 | 25 |
| Jupiter | 400 | 10 | 600 |
| Saturn | 600 | 25 | 1500 |
| Uranus | 50 | 2 | 1000 |
| Neptune | 10 | 1 | 200 |

The independent argument is T_eph, which the source equates to TDB (JDTDB). This
project supplies TT. TDB − TT is periodic and bounded near 1.7 ms, which
displaces Earth along its orbit by roughly 50 m — about five orders of magnitude
below the 6000 km nominal distance error for the same body. The substitution is
therefore immaterial at this model's accuracy and is recorded here rather than
silently assumed.

**Source-page quirk:** the element tables label the eccentricity column
`rad, rad/Cy`. Eccentricity is dimensionless; the label is an artefact of a
shared table header. Values are used as dimensionless.

## S2 — JPL SSD, Planetary Physical Parameters

**URL:** https://ssd.jpl.nasa.gov/planets/phys_par.html
**Used for:** equatorial radius, mean radius, mass, bulk density, sidereal
rotation period, sidereal orbital period, V(1,0) absolute magnitude, geometric
albedo, equatorial surface gravity, escape velocity.

Sign convention: a negative sidereal rotation period denotes retrograde
rotation. Venus (−243.018 d) and Uranus (−0.71833 d) are the two such cases.
This project does not branch on those signs; retrograde motion emerges from the
IAU orientation model in S4.

## S3 — JPL SSD, Astrodynamic Parameters

**URL:** https://ssd.jpl.nasa.gov/astro_par.html
**Used for:** astronomical unit, speed of light, Newtonian constant of
gravitation, J2000 obliquity of the ecliptic, heliocentric gravitational
constant, DE440 planetary system GM values, Julian year and century.

Notable definitions:

- `au = 149597870700 m` — exact by IAU 2012 Resolution B1.
- `GM_sun = 1.32712440041279419e20 m^3 s^-2` — DE440 (Park et al. 2021).
- Obliquity at J2000 = `84381.412 ± 0.005 ″`.

The GM values published here are **system** values for Mars outward: they include
the mass of the planet's satellites. Using a system GM as a planet GM is correct
for heliocentric orbit propagation and wrong for satellite orbit propagation
about that planet. Flagged in the data file at the point of use.

## S4 — NAIF generic PCK, `pck00011.tpc`

**URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc
**Encodes:** Archinal, B. A. et al., "Report of the IAU Working Group on
Cartographic Coordinates and Rotational Elements: 2015", *Celestial Mechanics
and Dynamical Astronomy*.
**Used for:** `src/data/iau-rotation.ts` — pole right ascension α₀, pole
declination δ₀, prime-meridian angle W₀ and rate Ẇ, nutation/precession
amplitudes and angle definitions; plus triaxial radii, which supply the polar
radius and hence flattening.

The kernel contains both superseded (lowercase) and current (uppercase)
assignments. **Only the uppercase current values are used.** Where the two
differ materially the discrepancy is noted in the data file; Neptune is the
clearest case, with a superseded Ẇ of 536.3128492 °/d against a current value of
541.1397757 °/d.

Convention: α₀ and δ₀ are polynomials in Julian centuries past J2000 TDB, W is a
polynomial in days past J2000 TDB. Retrograde rotation appears as a negative Ẇ,
and a pole below the ecliptic appears as a negative δ₀. No body is special-cased.

### Cross-source conflict: Neptune rotation rate (measured)

S2 and S4 disagree for exactly one body.

| Source | Value | Implied period |
| --- | --- | --- |
| S2 sidereal rotation period | 0.671250 d | — |
| S4 **superseded** Ẇ | 536.3128492 °/d | 0.671250 d |
| S4 **current** Ẇ | 541.1397757 °/d | 0.665262 d |

The S2 period reproduces the superseded kernel rate exactly, so S2 has not been
updated to the IAU 2015 value. The disagreement is 0.89%, which accumulates to a
full rotation of phase error in about 75 days.

Resolution: orientation uses the **current** S4 rate, because orientation is S4's
subject matter. The S2 period is retained for display and flagged in place. Both
files carry a comment warning against "fixing" the mismatch by reverting.

Every other body agrees between these two sources to within 5e-6 relative,
which is rounding.

### Obliquity is not derivable from S4 alone

Conventional planetary obliquity is measured from the body's **orbital plane**,
not from the ecliptic. Computing the pole-to-ecliptic angle from S4 gives the
right answer only for Earth, whose orbital plane defines the ecliptic.

Measured discrepancy, pole-to-ecliptic versus published obliquity:

| Body | Pole-to-ecliptic | Published | Orbital inclination |
| --- | --- | --- | --- |
| Earth | 23.4393° | 23.44° | 0° by definition |
| Mars | 25.4038° | 25.19° | 1.85° |
| Jupiter | 2.2165° | 3.13° | 1.30° |
| Saturn | 28.0522° | 26.73° | 2.49° |
| Uranus | 97.7218° | 97.77° | 0.77° |
| Venus | 178.7610° | 177.36° | 3.39° |

The residual tracks orbital inclination, as expected. Obliquity therefore
requires S1 orbital elements together with the S4 pole, and is computed in the
ephemeris layer rather than the data layer. No obliquity value is stored as data.

Retrograde rotation is detected from the sign of Ẇ, and the angular-momentum
vector opposes the IAU pole in that case. Venus reporting 178.76° rather than
1.24° depends on that sign handling.

## S5 — IAU 2015 Resolution B3

**Citation:** IAU 2015 Resolution B3, "On recommended nominal conversion
constants for selected solar and planetary properties".
**Used for:** nominal solar luminosity `3.828e26 W` and nominal solar radius
`6.957e8 m`.

These are defined constants for consistent reporting, not measurements of a
variable star. The solar irradiance validation target in `sim/irradiance.ts` is
derived from this luminosity together with the S3 astronomical unit; it is a
computed consequence of two cited definitions, not an independently asserted
figure.

## S6 — Espenak & Meeus, Polynomial Expressions for Delta T

**URL:** https://eclipse.gsfc.nasa.gov/SEcat5/deltatpoly.html
**Origin:** *Five Millennium Canon of Solar Eclipses: −1999 to +3000*,
NASA/TP-2006-214141.
**Used for:** `deltaT(year)` in `src/core/jd.ts`.

All published segments are implemented, including the deep-past parabola.
Implementing only the modern segments and falling back to that parabola produces
a 17 s discontinuity at year 1700; simulation time is scrubbable, so any
discontinuity in the domain is reachable. Largest remaining seam is 0.25 s at
1600, measured.

Regimes are reported distinctly because their epistemic status differs:

| Regime | Years | Meaning |
| --- | --- | --- |
| `FITTED` | −500 … 2005 | Backed by the observational record behind the fit. |
| `PREDICTED` | 2005 … | Forward projection of an irregular quantity. |
| `EXTRAPOLATED` | … −500 | Long-term parabola, no eclipse record behind it. |

For 2026 the expression yields ≈75 s against an observed value nearer 69 s. That
6 s error displaces Earth roughly 180 km along its orbit, against ≈6000 km of
intrinsic error in the S1 element model for the same body, so it is not the
limiting term. Reported as approximate regardless.

## S7 — Meeus, Astronomical Algorithms

**Citation:** Meeus, J. (1998) *Astronomical Algorithms*, 2nd ed., Willmann-Bell.
**Used for:** calendar ↔ Julian Date conversion (ch. 7), including the 1582
Gregorian reform branch; the reference JD values asserted in
`test/unit/jd.test.ts` come from ch. 7 table 7.A and examples 7.a/7.b.

---

## Deliberate omissions

Recorded so their absence is a stated decision rather than an oversight.

| Omitted | Magnitude | Rationale |
| --- | --- | --- |
| Mercury libration terms in W | ≈0.01° | Below the angular resolution of any M1 view. Framework supports them; amplitudes are in S4 if needed. |
| Mars higher-order nutation | ≲0.001° | As above. |
| Moon (301) nutation series, 13 terms | up to 3.9° | Material, but the Moon is scheduled for M4 with the ELP2000 provider. Not approximated in the interim. |
| TDB − TT periodic terms | ≲1.7 ms | Five orders below the S1 position error. See S1. |
| UT1 − UTC in the TT conversion | <0.9 s | Bounded by leap-second insertion. See S6. |
| Leap seconds in `addSeconds` | cumulative | Time-scale conversion, not arithmetic, is where these belong. |

## Values NOT sourced from the above

`sim/scale.ts` render transforms, depth-slab boundaries, marker pixel
thresholds, selection radii, and tone-mapping exposure are **rendering
parameters**, not astronomical measurements. They carry no citation because they
assert nothing about the physical world. They are documented in their own
modules and must never appear in an interface panel as though they were
measured quantities.
