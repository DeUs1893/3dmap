import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { groundY } from './terrain.js';

const MIN_CLEARANCE = 1.7; // eye height — allows first-person views

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
    this.orbit.minDistance = 5;
    this.orbit.maxDistance = 7000;
    this.orbit.maxPolarAngle = THREE.MathUtils.degToRad(88);
    this.orbit.screenSpacePanning = false;

    // first-person state (fly + walk)
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.flySpeed = 90;
    this.velocity = new THREE.Vector3();
    this.eyeHeight = 1.7;
    this.isBlocked = () => false; // building collision, injected by main

    this.onModeChange = () => {};

    domElement.addEventListener('click', () => {
      if (this.isFirstPerson() && document.pointerLockElement !== domElement) {
        domElement.requestPointerLock();
      }
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.isFirstPerson() && document.pointerLockElement !== domElement) {
        this.setMode('orbit');
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.isFirstPerson() || document.pointerLockElement !== this.dom) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.45, 1.45);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'KeyF' && !e.repeat) this.setMode(this.mode === 'fly' ? 'orbit' : 'fly');
      if (e.code === 'KeyG' && !e.repeat) this.setMode(this.mode === 'walk' ? 'orbit' : 'walk');
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

  isFirstPerson() {
    return this.mode === 'fly' || this.mode === 'walk';
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.flight = null;
    if (mode === 'fly' || mode === 'walk') {
      this.orbit.enabled = false;
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = mode === 'walk' ? 0 : Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      this.velocity.set(0, 0, 0);
      this.dom.requestPointerLock?.();
      // tighter near plane on foot so nearby walls don't clip
      if (mode === 'walk' && this.camera.near !== 0.9) {
        this.camera.near = 0.9;
        this.camera.updateProjectionMatrix();
      }
    } else {
      document.exitPointerLock?.();
      if (this.camera.near !== 2) {
        this.camera.near = 2;
        this.camera.updateProjectionMatrix();
      }
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
    } else if (this.mode === 'walk') {
      // first-person walk: ground-locked, building collision, slide along walls
      const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 7 : 2.4;
      const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const move = new THREE.Vector3();
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(forward);
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(forward);
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);

      this.velocity.lerp(move, 1 - Math.exp(-dt * 10));
      const p = this.camera.position;
      const nx = p.x + this.velocity.x * dt;
      const nz = p.z + this.velocity.z * dt;
      if (!this.isBlocked(nx, nz)) {
        p.x = nx;
        p.z = nz;
      } else if (!this.isBlocked(nx, p.z)) {
        p.x = nx; // slide along the wall
      } else if (!this.isBlocked(p.x, nz)) {
        p.z = nz;
      }
      // follow the terrain at eye height, smoothed against heightmap steps,
      // plus a subtle head bob while moving
      this.bobPhase = (this.bobPhase ?? 0) + this.velocity.length() * dt * 2.6;
      const bob = Math.sin(this.bobPhase) * 0.04 * Math.min(1, this.velocity.length() / 2.4);
      const targetY = groundY(p.x, p.z) + this.eyeHeight + bob;
      p.y += (targetY - p.y) * (1 - Math.exp(-dt * 12));

      this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
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
