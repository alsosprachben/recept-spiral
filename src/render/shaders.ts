export const VERTEX_SHADER = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = p;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

/**
 * One fragment per screen pixel: map back to (octave, pitch class) and sample the
 * sensor texture. The spiral is Archimedean in log frequency — angle is the pitch
 * class, radius grows by `k` per octave — so octaves line up radially and a
 * harmonic series is a fixed angular pattern at every pitch.
 */
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;

uniform sampler2D tex;   // x: position within octave, y: octave
                         // R brightness, G phase, B onset, A decay
uniform vec2  aspect;    // keeps the disc round in a non-square canvas
uniform float r0;        // inner radius, fraction of the disc
uniform float k;         // radial distance per octave
uniform float octaves;
uniform float band;      // arm width as a fraction of k
uniform int   mode;      // 0 amplitude, 1 phase hue, 2 free energy
uniform float shift;     // texture x offset so pitch class a reads the cell that sits at a

const float TAU = 6.283185307179586;

vec3 hsv(float h, float s, float v) {
  vec3 c = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), c, s);
}

void main() {
  vec2 d = uv * aspect;
  float r = length(d);

  // pitch class: 0 at 12 o'clock, increasing clockwise
  float a = fract(atan(d.x, d.y) / TAU);
  float s_cont = (r - r0) / k;
  float n = floor(s_cont - a + 0.5);   // the turn (octave) nearest this pixel
  float s = n + a;                     // continuous log2(f / f_ref)
  if (s < 0.0 || s >= octaves) { color = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float arm = r0 + k * s;
  float dist = abs(r - arm) / (0.5 * k * band);
  if (dist > 1.0) { color = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float edge = 1.0 - smoothstep(0.7, 1.0, dist);

  vec4 t = texture(tex, vec2(a + shift, (n + 0.5) / octaves));
  float amp = t.r;

  vec3 rgb;
  if (mode == 0) {
    rgb = vec3(amp) * vec3(1.0, 0.95, 0.85);
  } else if (mode == 1) {
    rgb = hsv(t.g, 0.75, amp);
  } else {
    rgb = mix(vec3(0.3, 0.5, 1.0) * t.a, vec3(1.0, 0.3, 0.2) * t.b, step(t.a, t.b))
        * (0.35 + 0.65 * amp);
  }
  color = vec4(rgb * edge, 1.0);
}
`;
