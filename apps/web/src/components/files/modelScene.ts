import {
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type BufferGeometry,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { observeResize } from "~/lib/observeResize";

/** Renders only on camera changes and resizes, so an idle model costs no frames. */
export function mountModelScene(host: HTMLElement, geometry: BufferGeometry) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.domElement.className = "absolute inset-0 size-full";
  host.append(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 0.1, 1000);
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 1.5, 1);
  camera.add(key);
  scene.add(camera, new HemisphereLight(0xffffff, 0x50555c, 1.4));
  const material = new MeshStandardMaterial({
    color: 0x9aa3ae,
    roughness: 0.55,
    metalness: 0.05,
    side: DoubleSide,
  });
  scene.add(new Mesh(geometry, material));

  const controls = new OrbitControls(camera, renderer.domElement);
  const render = () => renderer.render(scene, camera);
  controls.addEventListener("change", render);

  const radius = geometry.boundingSphere?.radius || 1;
  const reset = () => {
    const vertical = (camera.fov * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
    const distance = (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.05;
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.position.set(1, 0.75, 1.25).normalize().multiplyScalar(distance);
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
    render();
  };
  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  resize();
  reset();
  const stopResize = observeResize(host, resize);

  return {
    reset,
    dispose: () => {
      stopResize();
      controls.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
