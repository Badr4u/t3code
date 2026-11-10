import { RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BufferAttribute, BufferGeometry, Mesh, Vector3, type Group } from "three";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { mountModelScene } from "./modelScene";
import { readBinaryPreview } from "./readBinaryPreview";

interface Model {
  readonly geometry: BufferGeometry;
  readonly size: Vector3;
  readonly triangles: number;
}

/** Flattens every mesh in a 3MF build into one positions-only geometry; colors and textures are dropped. */
function mergeMeshes(group: Group) {
  group.updateMatrixWorld(true);
  const parts: Float32Array[] = [];
  group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const source: BufferGeometry = object.geometry;
    const flat = source.index ? source.toNonIndexed() : source;
    const positions = flat.getAttribute("position").clone().applyMatrix4(object.matrixWorld);
    parts.push(Float32Array.from(positions.array));
    if (flat !== source) flat.dispose();
    source.dispose();
    for (const material of [object.material].flat()) material.dispose();
  });
  const merged = new Float32Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(merged, 3));
  return geometry;
}

function parseModel(name: string, buffer: ArrayBuffer): Model {
  const format = /\.3mf$/i.test(name) ? "3MF" : "STL";
  let geometry: BufferGeometry;
  try {
    geometry =
      format === "3MF"
        ? mergeMeshes(new ThreeMFLoader().parse(buffer))
        : new STLLoader().parse(buffer);
  } catch {
    throw new Error(`This ${format} file is damaged or unsupported.`);
  }
  const triangles = geometry.getAttribute("position").count / 3;
  if (triangles < 1) {
    geometry.dispose();
    throw new Error(`This ${format} file has no triangles.`);
  }
  // Many exporters write zero facet normals, which light as solid black.
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const size = geometry.boundingBox?.getSize(new Vector3()) ?? new Vector3();
  // STL and 3MF models are Z-up; three.js is Y-up.
  geometry.rotateX(-Math.PI / 2);
  geometry.center();
  geometry.computeBoundingSphere();
  return { geometry, size, triangles };
}

const formatLength = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 2 : 1 });

export default function ModelViewer(props: { readonly src: string; readonly name: string }) {
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetch and parse the model from its URL, aborting the request and freeing the geometry when the source changes or unmounts.
  useEffect(() => {
    const controller = new AbortController();
    let geometry: BufferGeometry | null = null;
    void readBinaryPreview(props.src, controller.signal)
      .then((buffer) => {
        if (controller.signal.aborted) return;
        const parsed = parseModel(props.name, buffer);
        geometry = parsed.geometry;
        setModel(parsed);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "The model could not be loaded.");
      });
    return () => {
      controller.abort();
      geometry?.dispose();
    };
  }, [props.src, props.name]);
  const geometry = model?.geometry ?? null;
  const mountScene = (host: HTMLDivElement) => {
    if (!geometry) return;
    let scene: ReturnType<typeof mountModelScene>;
    try {
      scene = mountModelScene(host, geometry);
    } catch {
      setError("3D previews need WebGL, which is unavailable here.");
      return;
    }
    resetRef.current = scene.reset;
    return () => {
      resetRef.current = null;
      scene.dispose();
    };
  };
  if (error) return <FileSurfaceFailure message={error} />;
  if (!model) return <FileSurfaceLoading />;
  const { size, triangles } = model;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={mountScene}
        role="img"
        aria-label={`3D model of ${props.name}`}
        className="relative min-h-0 flex-1 cursor-grab touch-none active:cursor-grabbing"
      />
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border/60 px-3 text-xs text-muted-foreground tabular-nums">
        <span className="min-w-0 flex-1 truncate">
          {formatLength(size.x)} × {formatLength(size.y)} × {formatLength(size.z)} mm ·{" "}
          {triangles.toLocaleString()} triangles
        </span>
        <FileSurfaceAction label="Reset view" onPress={() => resetRef.current?.()}>
          <RotateCcwIcon className="size-3.5" />
        </FileSurfaceAction>
      </div>
    </div>
  );
}
