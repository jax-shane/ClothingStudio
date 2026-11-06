import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// GTA model space is Z-up with the front toward +Y. Clothing is already in that
// space; props are stored in the attach-bone's space where +X points up.
const TO_THREE = {
  component: (x, y, z) => [x, z, -y], // peds face -Y in model space; put the front toward the camera (+Z)
  prop: (x, y, z) => [z, x, y],
};

// rotate vector v by quaternion q = [x, y, z, w]
function qrot(q, v) {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}

export class Viewer {
  constructor(container) {
    this.el = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0f12);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 50);
    this.camera.position.set(0, 0.2, 2);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5568, 1.25));
    this.key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.key, this.key.target);
    const fill = new THREE.DirectionalLight(0x9db8ff, 0.5);
    fill.position.set(-2, 1, -1.5);
    this.scene.add(fill);

    this.group = new THREE.Group();          // the piece being edited
    this.scene.add(this.group);
    this.bodyGroup = new THREE.Group();      // optional mannequin
    this.scene.add(this.bodyGroup);

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.35,
    });

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.invalidate());

    this.texture = null;
    this.dirty = true;
    this.light = false;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  resize() {
    const w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  invalidate() { this.dirty = true; }

  loop() {
    requestAnimationFrame(this.loop);
    const moving = this.controls.update();
    this.key.position.copy(this.camera.position).add(new THREE.Vector3(0.6, 0.8, 0.4));
    if (this.dirty || moving) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Build a three.js geometry from one parsed .ydd geometry. posXf / norXf map GTA space -> three space. */
  buildGeometry(g, posXf, norXf) {
    const n = g.vertexCount;
    const pos = new Float32Array(n * 3);
    const nor = g.normals ? new Float32Array(n * 3) : null;
    for (let i = 0; i < n; i++) {
      pos.set(posXf(g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]), i * 3);
      if (nor) nor.set(norXf(g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]), i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (g.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
    if (nor) geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); else geo.computeVertexNormals();
    return geo;
  }

  /**
   * drawable: one entry of readYdd().drawables.
   * bone: optional { pos, rot } bind transform of the bone a prop is attached to; with it the prop is
   * seated on the mannequin, without it the prop is simply stood upright.
   */
  setMesh(drawable, isProp, bone) {
    for (const m of [...this.group.children]) { m.geometry.dispose(); this.group.remove(m); }
    if (!drawable || !drawable.models.length) { this.invalidate(); return 0; }
    let posXf, norXf;
    if (isProp && bone) {
      const q = bone.rot, p = bone.pos;
      const rot = (x, y, z) => qrot(q, [x, y, z]);
      posXf = (x, y, z) => { const v = rot(x, y, z); return TO_THREE.component(v[0] + p[0], v[1] + p[1], v[2] + p[2]); };
      norXf = (x, y, z) => { const v = rot(x, y, z); return TO_THREE.component(v[0], v[1], v[2]); };
    } else {
      posXf = norXf = isProp ? TO_THREE.prop : TO_THREE.component;
    }
    let tris = 0;
    for (const g of drawable.models[0].geometries) {
      this.group.add(new THREE.Mesh(this.buildGeometry(g, posXf, norXf), this.material));
      tris += g.indexCount / 3;
    }
    this.frame();
    return tris;
  }

  /** Mannequin from { parts:[{comp, drawable, texture}] } (null clears it). */
  setBody(data) {
    for (const m of [...this.bodyGroup.children]) {
      m.geometry.dispose();
      if (m.material.map) m.material.map.dispose();
      m.material.dispose();
      this.bodyGroup.remove(m);
    }
    if (data) {
      for (const part of data.parts) {
        let map = null;
        if (part.texture) {
          const t = part.texture;
          map = new THREE.DataTexture(new Uint8Array(t.rgba.buffer, t.rgba.byteOffset, t.rgba.byteLength), t.width, t.height, THREE.RGBAFormat);
          map.colorSpace = THREE.SRGBColorSpace;
          map.wrapS = map.wrapT = THREE.RepeatWrapping;
          map.minFilter = THREE.LinearMipmapLinearFilter;
          map.generateMipmaps = true;
          map.anisotropy = 4;
          map.needsUpdate = true;
        }
        const mat = new THREE.MeshStandardMaterial({ color: map ? 0xffffff : 0xb08a72, map, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
        for (const g of part.drawable.models[0].geometries) {
          const mesh = new THREE.Mesh(this.buildGeometry(g, TO_THREE.component, TO_THREE.component), mat);
          mesh.userData.comp = part.comp;
          this.bodyGroup.add(mesh);
        }
      }
    }
    this.invalidate();
  }

  showBody(on) { this.bodyGroup.visible = !!on; this.invalidate(); }

  /** Hide body slots that the edited garment replaces (e.g. 'lowr' when editing pants). */
  hideBodyParts(comps) {
    for (const m of this.bodyGroup.children) m.visible = !comps.has(m.userData.comp);
    this.invalidate();
  }

  /** The canvas is re-uploaded to the GPU whenever refresh() is called. */
  setTextureCanvas(canvas) {
    if (this.texture) this.texture.dispose();
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.flipY = false;            // GTA UVs start at the top-left like the image
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.anisotropy = 8;
    this.material.map = this.texture;
    this.material.needsUpdate = true;
    this.invalidate();
  }

  refresh() {
    if (this.texture) this.texture.needsUpdate = true;
    this.invalidate();
  }

  frame() {
    const box = new THREE.Box3().setFromObject(this.group);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.01);
    const dist = (maxDim / (2 * Math.tan((this.camera.fov * Math.PI) / 360))) * 1.35;
    this.camera.near = dist / 100; this.camera.far = dist * 100;
    this.camera.position.set(c.x, c.y + size.y * 0.04, c.z + dist);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
    this.invalidate();
  }

  setWireframe(on) { this.material.wireframe = on; this.invalidate(); }

  toggleBackground() {
    this.light = !this.light;
    this.scene.background = new THREE.Color(this.light ? 0xc9ced6 : 0x0d0f12);
    this.invalidate();
  }
}
