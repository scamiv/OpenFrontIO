import { GameMap, TileRef } from "../game/GameMap";
import { BezenhamLine } from "../utilities/Line";
import {
  MultiSourceAnyTargetBFSOptions,
  MultiSourceAnyTargetBFSResult,
} from "./MultiSourceAnyTargetBFS";

export type LazyThetaStarResult = MultiSourceAnyTargetBFSResult & {
  waypoints: TileRef[];
  tiles: TileRef[];
};

function sign(n: number): -1 | 0 | 1 {
  return n === 0 ? 0 : n > 0 ? 1 : -1;
}

function lineOfSightWater(
  gm: GameMap,
  from: TileRef,
  to: TileRef,
  w: number,
  noCornerCutting: boolean,
  allowed?: MultiSourceAnyTargetBFSOptions["allowedMask"],
): boolean {
  const x0 = gm.x(from);
  const y0 = gm.y(from);
  const x1 = gm.x(to);
  const y1 = gm.y(to);

  const line = new BezenhamLine({ x: x0, y: y0 }, { x: x1, y: y1 });

  let prevX = x0;
  let prevY = y0;
  let point = line.increment();
  while (point !== true) {
    const t = point.y * w + point.x;
    if (!gm.isWater(t)) return false;
    if (allowed && allowed.regionStamp[allowed.tileToRegion[t]!] !== allowed.stamp) {
      return false;
    }

    if (noCornerCutting) {
      const dx = sign(point.x - prevX);
      const dy = sign(point.y - prevY);
      if (dx !== 0 && dy !== 0) {
        const orthoA = prevY * w + (prevX + dx);
        const orthoB = (prevY + dy) * w + prevX;
        if (!gm.isWater(orthoA) || !gm.isWater(orthoB)) return false;
      }
    }

    prevX = point.x;
    prevY = point.y;
    point = line.increment();
  }

  if (!gm.isWater(to)) return false;
  if (allowed && allowed.regionStamp[allowed.tileToRegion[to]!] !== allowed.stamp) {
    return false;
  }
  return true;
}

function expandLine(
  gm: GameMap,
  from: TileRef,
  to: TileRef,
  w: number,
  out: TileRef[],
) {
  const x0 = gm.x(from);
  const y0 = gm.y(from);
  const x1 = gm.x(to);
  const y1 = gm.y(to);
  const line = new BezenhamLine({ x: x0, y: y0 }, { x: x1, y: y1 });
  let point = line.increment();
  while (point !== true) {
    const t = point.y * w + point.x;
    if (out.length === 0 || out[out.length - 1] !== t) out.push(t);
    point = line.increment();
  }
  if (out.length === 0 || out[out.length - 1] !== to) out.push(to);
}

function euclidean(gm: GameMap, a: TileRef, b: TileRef): number {
  const dx = gm.x(a) - gm.x(b);
  const dy = gm.y(a) - gm.y(b);
  return Math.sqrt(dx * dx + dy * dy);
}

export class LazyThetaStar {
  private stamp = 1;
  private readonly seenStamp: Uint32Array;
  private readonly openStamp: Uint32Array;
  private readonly closedStamp: Uint32Array;
  private readonly targetStamp: Uint32Array;
  private readonly gScore: Float32Array;
  private readonly fScore: Float32Array;
  private readonly hScore: Float32Array;
  private readonly parent: Int32Array;
  private readonly startOf: Int32Array;
  private readonly heap: Int32Array;
  private readonly heapIndex: Int32Array;

  constructor(numTiles: number) {
    this.seenStamp = new Uint32Array(numTiles);
    this.openStamp = new Uint32Array(numTiles);
    this.closedStamp = new Uint32Array(numTiles);
    this.targetStamp = new Uint32Array(numTiles);
    this.gScore = new Float32Array(numTiles);
    this.fScore = new Float32Array(numTiles);
    this.hScore = new Float32Array(numTiles);
    this.parent = new Int32Array(numTiles);
    this.startOf = new Int32Array(numTiles);
    this.heap = new Int32Array(numTiles);
    this.heapIndex = new Int32Array(numTiles);
  }

  private nextStamp(): number {
    const next = (this.stamp + 1) >>> 0;
    this.stamp = next === 0 ? 1 : next;
    return this.stamp;
  }

  findWaterPathFromSeeds(
    gm: GameMap,
    seedNodes: readonly TileRef[],
    seedOrigins: readonly TileRef[],
    targets: readonly TileRef[],
    opts: MultiSourceAnyTargetBFSOptions = {},
  ): LazyThetaStarResult | null {
    if (seedNodes.length === 0 || targets.length === 0) return null;

    const w = gm.width();
    const h = gm.height();
    const lastRowStart = (h - 1) * w;

    const stamp = this.nextStamp();
    const allowed = opts.allowedMask;
    const visitedOut = opts.visitedMaskOut;

    // Filter targets to valid, traversable tiles under the current allowed mask.
    const targetX: number[] = [];
    const targetY: number[] = [];
    for (const t of targets) {
      if (t < 0 || t >= this.targetStamp.length) continue;
      if (!gm.isWater(t)) continue;
      if (allowed && allowed.regionStamp[allowed.tileToRegion[t]!] !== allowed.stamp) {
        continue;
      }
      this.targetStamp[t] = stamp;
      targetX.push(gm.x(t));
      targetY.push(gm.y(t));
    }
    if (targetX.length === 0) return null;

    const kingMoves = opts.kingMoves ?? true;
    const noCornerCutting = opts.noCornerCutting ?? true;

    const heuristic = (tile: TileRef): number => {
      const x = gm.x(tile);
      const y = gm.y(tile);
      let best = Infinity;
      for (let i = 0; i < targetX.length; i++) {
        const dx = x - targetX[i]!;
        const dy = y - targetY[i]!;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) best = d;
      }
      return best;
    };

    let heapSize = 0;

    const heapLess = (a: TileRef, b: TileRef): boolean => {
      const fa = this.fScore[a]!;
      const fb = this.fScore[b]!;
      if (fa !== fb) return fa < fb;
      const ha = this.hScore[a]!;
      const hb = this.hScore[b]!;
      if (ha !== hb) return ha < hb;
      return a < b;
    };

    const heapSwap = (i: number, j: number) => {
      const ti = this.heap[i]!;
      const tj = this.heap[j]!;
      this.heap[i] = tj;
      this.heap[j] = ti;
      this.heapIndex[ti] = j + 1;
      this.heapIndex[tj] = i + 1;
    };

    const heapBubbleUp = (i: number) => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!heapLess(this.heap[i] as TileRef, this.heap[p] as TileRef)) break;
        heapSwap(i, p);
        i = p;
      }
    };

    const heapBubbleDown = (i: number) => {
      while (true) {
        const l = (i << 1) + 1;
        if (l >= heapSize) break;
        const r = l + 1;
        let m = l;
        if (
          r < heapSize &&
          heapLess(this.heap[r] as TileRef, this.heap[l] as TileRef)
        ) {
          m = r;
        }
        if (!heapLess(this.heap[m] as TileRef, this.heap[i] as TileRef)) break;
        heapSwap(i, m);
        i = m;
      }
    };

    const heapPushOrDecrease = (t: TileRef) => {
      if (this.openStamp[t] === stamp) {
        heapBubbleUp((this.heapIndex[t]! - 1) | 0);
        return;
      }
      this.openStamp[t] = stamp;
      const i = heapSize++;
      this.heap[i] = t;
      this.heapIndex[t] = i + 1;
      heapBubbleUp(i);
    };

    const heapPopMin = (): TileRef | null => {
      if (heapSize <= 0) return null;
      const min = this.heap[0] as TileRef;
      const last = this.heap[--heapSize] as TileRef;
      if (heapSize > 0) {
        this.heap[0] = last;
        this.heapIndex[last] = 1;
        heapBubbleDown(0);
      }
      this.openStamp[min] = 0;
      this.heapIndex[min] = 0;
      return min;
    };

    const ensureInit = (t: TileRef) => {
      if (this.seenStamp[t] === stamp) return;
      this.seenStamp[t] = stamp;
      this.gScore[t] = Infinity;
      this.fScore[t] = Infinity;
      this.hScore[t] = Infinity;
      this.parent[t] = -1;
      this.startOf[t] = -1;
      this.closedStamp[t] = 0;
      this.openStamp[t] = 0;
      this.heapIndex[t] = 0;
    };

    // Initialize seeds.
    const count = Math.min(seedNodes.length, seedOrigins.length);
    for (let i = 0; i < count; i++) {
      const node = seedNodes[i]!;
      const origin = seedOrigins[i]!;
      if (node < 0 || node >= this.seenStamp.length) continue;
      if (!gm.isWater(node)) continue;
      if (allowed && allowed.regionStamp[allowed.tileToRegion[node]!] !== allowed.stamp) {
        continue;
      }
      ensureInit(node);
      if (this.gScore[node] === 0) continue;
      this.gScore[node] = 0;
      this.hScore[node] = heuristic(node);
      this.fScore[node] = this.hScore[node];
      this.parent[node] = node;
      this.startOf[node] = origin;
      heapPushOrDecrease(node);
    }
    if (heapSize === 0) return null;

    const setVertex = (s: TileRef) => {
      const p = this.parent[s] as TileRef;
      if (p < 0 || p === s) return;

      if (lineOfSightWater(gm, p, s, w, noCornerCutting, allowed)) return;

      let bestParent: TileRef = -1;
      let bestG = Infinity;

      // Candidate cost uses Euclidean neighbor distances (1 / sqrt(2)), consistent with the
      // any-angle objective (we ultimately output waypoints and expand them via Bresenham).
      const tryCandidate = (cand: TileRef, dist: number) => {
        if (this.closedStamp[cand] !== stamp) return;
        const g = this.gScore[cand]! + dist;
        if (g < bestG || (g === bestG && cand < bestParent)) {
          bestG = g;
          bestParent = cand;
        }
      };

      const x = gm.x(s);
      const orthoDist = 1;
      const diagDist = Math.SQRT2;

      // Orthogonal neighbors.
      if (s >= w) tryCandidate(s - w, orthoDist);
      if (s < lastRowStart) tryCandidate(s + w, orthoDist);
      if (x !== 0) tryCandidate(s - 1, orthoDist);
      if (x !== w - 1) tryCandidate(s + 1, orthoDist);

      if (kingMoves) {
        // Diagonals, same corner-cutting rule as the BFS.
        if (
          s >= w &&
          x !== 0 &&
          (!noCornerCutting || (gm.isWater(s - w) && gm.isWater(s - 1)))
        ) {
          tryCandidate(s - w - 1, diagDist);
        }
        if (
          s >= w &&
          x !== w - 1 &&
          (!noCornerCutting || (gm.isWater(s - w) && gm.isWater(s + 1)))
        ) {
          tryCandidate(s - w + 1, diagDist);
        }
        if (
          s < lastRowStart &&
          x !== 0 &&
          (!noCornerCutting || (gm.isWater(s + w) && gm.isWater(s - 1)))
        ) {
          tryCandidate(s + w - 1, diagDist);
        }
        if (
          s < lastRowStart &&
          x !== w - 1 &&
          (!noCornerCutting || (gm.isWater(s + w) && gm.isWater(s + 1)))
        ) {
          tryCandidate(s + w + 1, diagDist);
        }
      }

      if (bestParent >= 0) {
        this.parent[s] = bestParent;
        this.gScore[s] = bestG;
        this.startOf[s] = this.startOf[bestParent]!;
      }
    };

    const relax = (from: TileRef, to: TileRef) => {
      if (!gm.isWater(to)) return;
      if (allowed && allowed.regionStamp[allowed.tileToRegion[to]!] !== allowed.stamp) {
        return;
      }
      if (this.closedStamp[to] === stamp) return;

      ensureInit(to);

      const parentFrom = kingMoves ? (this.parent[from] as TileRef) : from;
      const tentative = this.gScore[parentFrom]! + euclidean(gm, parentFrom, to);
      if (tentative >= this.gScore[to]!) return;

      this.gScore[to] = tentative;
      this.parent[to] = parentFrom;
      this.startOf[to] = this.startOf[from]!;
      this.hScore[to] = heuristic(to);
      this.fScore[to] = this.gScore[to]! + this.hScore[to]!;
      heapPushOrDecrease(to);
    };

    while (true) {
      const s = heapPopMin();
      if (s === null) break;
      if (this.closedStamp[s] === stamp) continue;

      // Ensure parent edge validity before using it (lazy LOS repair).
      setVertex(s);

      this.closedStamp[s] = stamp;
      if (visitedOut) {
        visitedOut.regionStamp[visitedOut.tileToRegion[s]!] = visitedOut.stamp;
      }

      if (this.targetStamp[s] === stamp) {
        // Reconstruct any-angle waypoint chain, then expand to a tile path.
        const waypoints: TileRef[] = [];
        let cur = s;
        waypoints.push(cur);
        while (true) {
          const p = this.parent[cur] as TileRef;
          if (p < 0 || p === cur) break;
          cur = p;
          waypoints.push(cur);
        }
        waypoints.reverse();

        // Validate and expand segments.
        const tiles: TileRef[] = [];
        for (let i = 0; i < waypoints.length - 1; i++) {
          const a = waypoints[i]!;
          const b = waypoints[i + 1]!;
          if (!lineOfSightWater(gm, a, b, w, noCornerCutting, allowed)) {
            return null;
          }
          expandLine(gm, a, b, w, tiles);
        }
        return {
          source: this.startOf[s] as TileRef,
          target: s,
          waypoints,
          tiles,
          path: tiles,
        };
      }

      const x = gm.x(s);

      // Orthogonal neighbors.
      if (s >= w) relax(s, s - w);
      if (s < lastRowStart) relax(s, s + w);
      if (x !== 0) relax(s, s - 1);
      if (x !== w - 1) relax(s, s + 1);

      if (!kingMoves) continue;

      // Diagonals (king moves). With noCornerCutting, forbid squeezing past land corners.
      if (
        s >= w &&
        x !== 0 &&
        (!noCornerCutting || (gm.isWater(s - w) && gm.isWater(s - 1)))
      ) {
        relax(s, s - w - 1);
      }
      if (
        s >= w &&
        x !== w - 1 &&
        (!noCornerCutting || (gm.isWater(s - w) && gm.isWater(s + 1)))
      ) {
        relax(s, s - w + 1);
      }
      if (
        s < lastRowStart &&
        x !== 0 &&
        (!noCornerCutting || (gm.isWater(s + w) && gm.isWater(s - 1)))
      ) {
        relax(s, s + w - 1);
      }
      if (
        s < lastRowStart &&
        x !== w - 1 &&
        (!noCornerCutting || (gm.isWater(s + w) && gm.isWater(s + 1)))
      ) {
        relax(s, s + w + 1);
      }
    }

    return null;
  }
}
