// Synthesized cathedral bells, positionally anchored at the Dom.
// Rings the hour count (capped) at every full hour of real time.
import * as THREE from 'three';

// renders one bell strike into an AudioBuffer (inharmonic partials, long decay)
function renderBellBuffer(ctx, fundamental = 130) {
  const seconds = 7;
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, rate * seconds, rate);
  const data = buf.getChannelData(0);
  // classic bell partial structure: hum, prime, tierce, quint, nominal …
  const partials = [
    { f: 0.5, a: 0.55, d: 0.45 },
    { f: 1.0, a: 1.0, d: 0.8 },
    { f: 1.19, a: 0.65, d: 1.1 },
    { f: 1.5, a: 0.35, d: 1.4 },
    { f: 2.0, a: 0.5, d: 1.8 },
    { f: 2.74, a: 0.25, d: 2.6 },
  ];
  for (let i = 0; i < data.length; i++) {
    const t = i / rate;
    let v = 0;
    for (const p of partials) {
      v += p.a * Math.sin(2 * Math.PI * fundamental * p.f * t) * Math.exp(-t * p.d);
    }
    // strike transient
    v += 0.4 * Math.sin(2 * Math.PI * fundamental * 4.2 * t) * Math.exp(-t * 14);
    data[i] = v * 0.16 * Math.exp(-t * 0.25);
  }
  return buf;
}

/**
 * Attaches positional bells to the scene. Audio unlocks on the first user
 * gesture (browser policy); afterwards the bells strike on every real full hour.
 */
export function startBells(camera, scene, position) {
  const listener = new THREE.AudioListener();
  let ctx = null;
  let buffer = null;
  let sound = null;
  let lastHourRung = -1;

  const unlock = () => {
    if (ctx) return;
    camera.add(listener);
    ctx = listener.context;
    if (ctx.state === 'suspended') ctx.resume();
    buffer = renderBellBuffer(ctx);
    sound = new THREE.PositionalAudio(listener);
    sound.setBuffer(buffer);
    sound.setRefDistance(250);
    sound.setMaxDistance(4000);
    sound.setRolloffFactor(1.2);
    const anchor = new THREE.Object3D();
    anchor.position.copy(position);
    anchor.add(sound);
    scene.add(anchor);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  function strike(times) {
    if (!sound || times <= 0) return;
    let n = 0;
    const ring = () => {
      // PositionalAudio plays one buffer at a time; clone-free re-trigger
      if (sound.isPlaying) sound.stop();
      sound.play();
      n++;
      if (n < times) setTimeout(ring, 2600);
    };
    ring();
  }

  return {
    /** call from the render loop */
    update() {
      if (!ctx) return;
      const now = new Date();
      if (now.getMinutes() === 0 && now.getSeconds() < 10 && now.getHours() !== lastHourRung) {
        lastHourRung = now.getHours();
        const count = now.getHours() % 12 || 12;
        strike(Math.min(count, 8));
      }
    },
    /** a single distant chime, e.g. when flying to a church */
    chime() {
      if (sound) strike(1);
    },
  };
}
