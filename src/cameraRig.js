import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { groundY } from './terrain.js';

const MIN_CLEARANCE = 2.5;

function easeInOutQuint(t) {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

export class CameraRig {
  constructor(camera, domElement, bounds) {
    this.camera = camera;
    this.dom = domElement;
    this.bounds = bounds;
    this.mode = 'orbit';
    this.flight = null;

    this.orbit = new OrbitControls(camera, domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.07;
    this.orbit.minDistance = 25;
    this.orbit.maxDistance = 7000;
    this.orbit.maxPolarAngle = THREE.MathUtils.degToRad(86);
    this.orbit.screenSpacePanning = false;

    // fly mode state
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.flySpeed = 90;
    this.velocity = new THREE.Vector3();

    this.onModeChange = () => {};

    domElement.addEventListener('click', () => {
      if (this.mode === 'fly' && document.pointerLockElement !== domElement) {
        domElement.requestPointerLock();
      }
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.mode === 'fly' && document.pointerLockElement !== domElement) {
        this.setMode('orbit');
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (this.mode !== 'fly' || document.pointerLockElement !== this.dom) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.45, 1.45);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'KeyF' && !e.repeat) this.toggleMode();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    domElement.addEventListener('wheel', (e) => {
      if (this.mode !== 'fly') return;
      this.flySpeed = THREE.MathUtils.clamp(this.flySpeed * (e.deltaY > 0 ? 0.85 : 1.18), 8, 900);
    });
  }

  toggleMode() {
    this.setMode(this.mode === 'orbit' ? 'fly' : 'orbit');
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.flight = null;
    if (mode === 'fly') {
      this.orbit.enabled = false;
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      this.dom.requestPointerLock?.();
    } else {
      document.exitPointerLock?.();
      // keep current view: target a point in front of the camera
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.orbit.target.copy(this.camera.position).addScaledVector(dir, 250);
      this.orbit.enabled = true;
    }
    this.onModeChange(mode);
  }

  /** Cinematic flight: camera → camPos while looking at lookAt. */
  flyTo(camPos, lookAt, duration = 2.4) {
    this.setMode('orbit');
    this.flight = {
      t: 0,
      duration,
      fromPos: this.camera.position.clone(),
      toPos: camPos.clone(),
      fromTarget: this.orbit.target.clone(),
      toTarget: lookAt.clone(),
    };
  }

  update(dt) {
    if (this.flight) {
      const f = this.flight;
      f.t += dt;
      const s = easeInOutQuint(Math.min(1, f.t / f.duration));
      this.camera.position.lerpVectors(f.fromPos, f.toPos, s);
      this.orbit.target.lerpVectors(f.fromTarget, f.toTarget, s);
      this.camera.lookAt(this.orbit.target);
      if (f.t >= f.duration) this.flight = null;
    } else if (this.mode === 'orbit') {
      this.orbit.update();
    } else {
      // fly mode
      const speed = this.flySpeed * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1);
      const forward = new THREE.Vector3(
        -Math.sin(this.yaw) * Math.cos(this.pitch),
        Math.sin(this.pitch),
        -Math.cos(this.yaw) * Math.cos(this.pitch)
      );
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const move = new THREE.Vector3();
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(forward);
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(forward);
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right);
      if (this.keys.has('KeyE') || this.keys.has('Space')) move.y += 1;
      if (this.keys.has('KeyQ') || this.keys.has('KeyC')) move.y -= 1;
      if (move.lengthSq() > 0) move.normalize();

      // smooth acceleration
      this.velocity.lerp(move.multiplyScalar(speed), 1 - Math.exp(-dt * 6));
      this.camera.position.addScaledVector(this.velocity, dt);

      this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    }

    // clamp to map bounds and above ground
    const p = this.camera.position;
    const b = this.bounds;
    p.x = THREE.MathUtils.clamp(p.x, b.minX - 800, b.maxX + 800);
    p.z = THREE.MathUtils.clamp(p.z, b.minZ - 800, b.maxZ + 800);
    p.y = Math.min(p.y, 4500);
    const minY =
      groundY(
        THREE.MathUtils.clamp(p.x, b.minX, b.maxX),
        THREE.MathUtils.clamp(p.z, b.minZ, b.maxZ)
      ) + MIN_CLEARANCE;
    if (p.y < minY) p.y = minY;
  }
}
