import { RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Vector3, type BufferGeometry } from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { readBinaryPreview } from "./readBinaryPreview";
import { mountStlScene } from "./stlScene";

interface StlModel {
  readonly geometry: BufferGeometry;
  readonly size: Vector3;
  readonly triangles: number;
}

function parseStl(buffer: ArrayBuffer): StlModel {
  let geometry: BufferGeometry;
  try {
    geometry = new STLLoader().parse(buffer);
  } catch {
    throw new Error("This STL file is damaged or unsupported.");
  }
  const triangles = geometry.getAttribute("position").count / 3;
  if (triangles < 1) {
    geometry.dispose();
    throw new Error("This STL file has no triangles.");
  }
  // Many exporters write zero facet normals, which light as solid black.
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const size = geometry.boundingBox?.getSize(new Vector3()) ?? new Vector3();
  // STL models are Z-up; three.js is Y-up.
  geometry.rotateX(-Math.PI / 2);
  geometry.center();
  geometry.computeBoundingSphere();
  return { geometry, size, triangles };
}

const formatLength = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 2 : 1 });

export default function StlViewer(props: { readonly src: string; readonly name: string }) {
  const [model, setModel] = useState<StlModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetch and parse the model from its URL, aborting the request and freeing the geometry when the source changes or unmounts.
  useEffect(() => {
    const controller = new AbortController();
    let geometry: BufferGeometry | null = null;
    void readBinaryPreview(props.src, controller.signal)
      .then((buffer) => {
        if (controller.signal.aborted) return;
        const parsed = parseStl(buffer);
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
  }, [props.src]);
  const geometry = model?.geometry ?? null;
  const mountScene = (host: HTMLDivElement) => {
    if (!geometry) return;
    let scene: ReturnType<typeof mountStlScene>;
    try {
      scene = mountStlScene(host, geometry);
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
