// Corner snapping for alignment pins (sextant-map.js snapToVertex). Run: node --test tests/frontend
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapToVertex } from "../../custom_components/sextant/frontend/sextant-map.js";

const rect = (x0, y0, x1, y1) => ({ cords: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] });
const rooms = [rect(0, 0, 400, 300), rect(400, 0, 800, 300)];

test("a pin dropped near a room corner lands exactly on it", () => {
  assert.deepEqual(snapToVertex({ x: 797, y: 296 }, rooms, 12), { x: 800, y: 300 });
});

test("out of reach of every corner the pin stays where it was put", () => {
  assert.equal(snapToVertex({ x: 200, y: 150 }, rooms, 12), null);
  assert.equal(snapToVertex({ x: 413, y: 0 }, rooms, 12), null);   // on a wall, but 13 px from its corner
});

test("the nearest corner wins, and a corner two rooms share is one corner", () => {
  assert.deepEqual(snapToVertex({ x: 405, y: 4 }, rooms, 12), { x: 400, y: 0 });
  assert.deepEqual(snapToVertex({ x: 9, y: 2 }, [rect(0, 0, 10, 10), rect(16, 0, 30, 10)], 12), { x: 10, y: 0 });
});

test("a floor with no rooms, or rooms with no points, snaps to nothing", () => {
  assert.equal(snapToVertex({ x: 1, y: 1 }, [], 12), null);
  assert.equal(snapToVertex({ x: 1, y: 1 }, undefined, 12), null);
  assert.equal(snapToVertex({ x: 1, y: 1 }, [{}], 12), null);
});
