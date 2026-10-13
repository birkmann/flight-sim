// Water on the camera's lens (src/weather/precip.rs), over the rendered view: beads that land and evaporate, and
// larger drops that run down in jerks, leaving a trail of small beads and a path wiped clear. Every drop is a tiny
// wide-angle lens: it shows the view around it, upside down, with a dark rim and a highlight.
//
// Distances are in screen heights, y down. Only a scattering of drops: fewer toward the middle of the view, which
// stays clear, and fewer still in a fast airflow, which blows them off (the rest run faster and are dragged outward
// from the middle, the way air parts around a lens moving forward).
#import bevy_core_pipeline::fullscreen_vertex_shader::FullscreenVertexOutput

struct LensRain {
    // Lens clock (s, runs faster in a fast airflow), wetness 0..1, running drops 0..1, airflow 0..1.
    a: vec4<f32>,
    // Light 0..1, unused.
    b: vec4<f32>,
}

@group(0) @binding(0) var screen: texture_2d<f32>;
@group(0) @binding(1) var screen_sampler: sampler;
@group(0) @binding(2) var<uniform> lens: LensRain;

fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn hash32(p: vec2<f32>) -> vec3<f32> {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * vec3<f32>(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// How many drops a spot keeps (0..1), from where it is on the screen: few in the middle, more toward the edges.
fn spread(c: vec2<f32>, mid: vec2<f32>) -> f32 {
    let off = (c - mid) / vec2<f32>(mid.x, 0.5);
    return mix(0.2, 1.0, smoothstep(0.2, 0.9, length(off)));
}

// A drop under a point: its height (0 outside, 1 at the centre), the point's offset from the centre in radii, and
// the radius.
struct Drop {
    h: f32,
    q: vec2<f32>,
    r: f32,
}

fn none() -> Drop {
    return Drop(0.0, vec2<f32>(0.0), 0.0);
}

fn shape(d: vec2<f32>, r: f32) -> Drop {
    if (r <= 0.0) {
        return none();
    }
    let q = d / r;
    let k = dot(q, q);
    if (k >= 1.0) {
        return none();
    }
    return Drop(sqrt(1.0 - k), q, r);
}

fn higher(a: Drop, b: Drop) -> Drop {
    if (b.h > a.h) {
        return b;
    }
    return a;
}

// Beads: at most one per cell, landing and evaporating on their own clocks.
fn beads(p: vec2<f32>, mid: vec2<f32>, cells: f32, seed: f32, t: f32, wet: f32, air: f32, wiped: f32) -> Drop {
    let g = p * cells;
    let id = floor(g) + seed;
    let life = mix(7.0, 16.0, hash12(id));
    let clock = t / life + hash12(id + 5.3);
    let cycle = floor(clock);
    let ph = fract(clock);
    let n = hash32(id + cycle * 17.17);
    // Decided per cell, so a drop is either there or not.
    if (n.x > wet * spread((floor(g) + 0.5) / cells, mid) * (1.0 - wiped)) {
        return none();
    }
    // Lands fast, then slowly shrinks away.
    let grow = smoothstep(0.0, 0.02, ph);
    let dry = 1.0 - smoothstep(0.55, 1.0, ph);
    let r = mix(0.14, 0.4, n.y) * grow * sqrt(dry);
    let c = (hash32(id + cycle * 3.7 + 1.9).xy - 0.5) * 0.25;
    let d = fract(g) - 0.5 - c;
    // In a fast airflow the beads are dragged into tears, away from the middle.
    let away = normalize(p - mid + vec2<f32>(1e-4, 0.0));
    let side = vec2<f32>(-away.y, away.x);
    var drop = shape(vec2<f32>(dot(d, side), dot(d, away) / (1.0 + 0.8 * air)), r);
    drop.q = drop.q.x * side + drop.q.y * away;
    drop.r = drop.r / cells;
    return drop;
}

// Stick-slip: the drop holds while it gathers water, then lurches.
fn slide(u: f32) -> f32 {
    let f = fract(u);
    return floor(u) + pow(f, 5.0) + 0.15 * f;
}

// Running drops, one per column at a time: they start somewhere on the lens and run down it.
struct Run {
    drop: Drop,
    // How much the path behind the drop is wiped clear.
    wipe: f32,
}

fn runs(p: vec2<f32>, mid: vec2<f32>, cols: f32, seed: f32, t: f32, amount: f32, air: f32) -> Run {
    var out = Run(none(), 0.0);
    let col = floor(p.x * cols);
    let period = mix(5.0, 9.0, hash12(vec2<f32>(col, seed)));
    let clock = t / period + hash12(vec2<f32>(col + 3.1, seed));
    let cycle = floor(clock);
    let age = fract(clock) * period;
    let n = hash32(vec2<f32>(col * 1.37 + cycle * 11.3, seed));
    if (n.x > amount * spread(vec2<f32>((col + 0.5) / cols, 0.5), mid)) {
        return out;
    }
    let r = mix(0.013, 0.028, n.y);
    let start = mix(-0.1, 0.8, n.z);
    let rate = mix(0.7, 1.5, hash12(vec2<f32>(cycle, col + seed))) * (1.0 + 3.0 * air);
    let y = start + slide(age * rate) * mix(0.035, 0.07, n.y) * (1.0 + 2.0 * air);
    // A column is 1/cols wide; the drop wanders across it.
    let wander = 0.18 / cols * sin(p.y * 23.0 + n.z * 30.0) + 0.1 / cols * sin(p.y * 61.0 + n.y * 20.0);
    let x = (col + 0.3 + 0.4 * n.z) / cols + wander;
    let fade = 1.0 - smoothstep(0.8, 1.0, age / period);
    let dx = p.x - x;
    // The drop: rounder at its front, drawn out behind.
    let dy = p.y - y;
    var d = vec2<f32>(dx, select(dy, dy * 0.65, dy < 0.0));
    d.y = d.y / (1.0 + 0.6 * air);
    out.drop = shape(d, r * fade);
    // Behind it, a path it wiped clear and a string of beads it left.
    let behind = step(start, p.y) * step(p.y, y - r * 0.5);
    let near = 1.0 - smoothstep(r * 0.4, r * 0.9, abs(dx));
    out.wipe = behind * near;
    let spacing = r * 1.6;
    let j = floor((p.y - start) / spacing);
    let m = hash32(vec2<f32>(j + cycle * 7.0, col + seed * 13.0));
    let bead_y = start + (j + 0.5) * spacing + (m.y - 0.5) * spacing * 0.4;
    let bead_r = r * mix(0.18, 0.4, m.x) * step(0.35, m.z) * (1.0 - smoothstep(0.0, period, age) * 0.6);
    if (behind > 0.0 && bead_y < y - r) {
        let bead = shape(vec2<f32>(dx - (m.x - 0.5) * r * 0.3, p.y - bead_y), bead_r);
        out.drop = higher(out.drop, bead);
    }
    return out;
}

@fragment
fn fragment(in: FullscreenVertexOutput) -> @location(0) vec4<f32> {
    let dims = vec2<f32>(textureDimensions(screen));
    let aspect = dims.x / dims.y;
    let scene = textureSampleLevel(screen, screen_sampler, in.uv, 0.0);
    let t = lens.a.x;
    let wet = lens.a.y;
    let amount = lens.a.z;
    let air = lens.a.w;
    if (wet <= 0.001) {
        return scene;
    }
    let s = vec2<f32>(in.uv.x * aspect, in.uv.y);
    let mid = vec2<f32>(aspect * 0.5, 0.5);

    // A fast airflow blows most of the water off.
    let kept = wet * (1.0 - 0.5 * air);
    let run_a = runs(s, mid, 7.0, 1.0, t, amount * kept * 0.5, air);
    let run_b = runs(s + vec2<f32>(0.5 / 7.0, 0.0), mid, 7.0, 2.0, t * 0.87, amount * kept * 0.3, air);
    let wiped = max(run_a.wipe, run_b.wipe);
    var drop = higher(run_a.drop, run_b.drop);
    drop = higher(drop, beads(s, mid, 22.0, 0.0, t, kept * 0.16, air, wiped));
    drop = higher(drop, beads(s + 0.37, mid + 0.37, 45.0, 40.0, t * 1.3, kept * 0.1, air, wiped));
    if (drop.h <= 0.0) {
        return scene;
    }
    // The point's offset from the drop's centre, in radii.
    let q = drop.q;
    let k = length(q);
    // A lens: the view around the drop, flipped through its centre.
    let centre = s - q * drop.r;
    let seen = centre - q * drop.r * 3.0;
    let uv = clamp(vec2<f32>(seen.x / aspect, seen.y), vec2<f32>(0.001), vec2<f32>(0.999));
    let px = 1.2 / dims;
    var inside = textureSampleLevel(screen, screen_sampler, uv, 0.0).rgb * 0.4;
    inside += textureSampleLevel(screen, screen_sampler, uv + vec2<f32>(px.x, px.y), 0.0).rgb * 0.15;
    inside += textureSampleLevel(screen, screen_sampler, uv + vec2<f32>(-px.x, px.y), 0.0).rgb * 0.15;
    inside += textureSampleLevel(screen, screen_sampler, uv + vec2<f32>(px.x, -px.y), 0.0).rgb * 0.15;
    inside += textureSampleLevel(screen, screen_sampler, uv + vec2<f32>(-px.x, -px.y), 0.0).rgb * 0.15;
    // Water gathers light: brighter inside, a dark rim where the surface bends the view away (heaviest at the top,
    // shaded by the drop's own body), a highlight from above and the light it focuses at its lower edge.
    inside *= 1.1;
    let rim = smoothstep(0.45, 1.0, k);
    let top = 1.0 - smoothstep(-0.8, 0.2, q.y);
    inside *= 1.0 - (0.5 + 0.25 * top) * rim * rim;
    let light = lens.b.x;
    let spec = 1.0 - smoothstep(0.0, 0.3, length(q - vec2<f32>(-0.3, -0.45)));
    let caustic = (1.0 - smoothstep(0.0, 0.35, length(vec2<f32>(q.x * 0.6, q.y - 0.72)))) * (1.0 - rim * 0.5);
    inside += vec3<f32>(0.92, 0.96, 1.0) * (spec * 0.9 + caustic * 0.3) * (0.25 + 0.75 * light);
    // Antialiased edge, a pixel and a half wide.
    let aa = 1.5 / (dims.y * drop.r);
    let mask = 1.0 - smoothstep(1.0 - aa, 1.0, k);
    return vec4<f32>(mix(scene.rgb, inside, mask), scene.a);
}
