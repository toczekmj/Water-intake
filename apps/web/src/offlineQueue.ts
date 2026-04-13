import { openDB } from "idb";
import { ApiRequestError, api } from "./api";

type QueuedIntake = {
  id: string;
  fluidId: number;
  volumeMl: number;
  occurredAt: string;
};

const DB_NAME = "hydrateme-offline";
const STORE = "intakeQueue";

async function db() {
  return openDB(DB_NAME, 1, {
    upgrade(upgradeDb) {
      if (!upgradeDb.objectStoreNames.contains(STORE)) {
        upgradeDb.createObjectStore(STORE, { keyPath: "id" });
      }
    }
  });
}

export async function enqueueIntake(item: QueuedIntake) {
  const d = await db();
  await d.put(STORE, item);
}

export async function getQueueSize() {
  const d = await db();
  return d.count(STORE);
}

export async function clearQueue() {
  const d = await db();
  await d.clear(STORE);
}

export async function flushQueue() {
  if (!navigator.onLine) {
    return;
  }
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  const store = tx.store;
  let cursor = await store.openCursor();
  while (cursor) {
    const value = cursor.value as QueuedIntake;
    try {
      await api.addIntake({
        fluidId: value.fluidId,
        volumeMl: value.volumeMl,
        occurredAt: value.occurredAt,
        clientEntryId: value.id
      });
      await cursor.delete();
    } catch (error) {
      // Drop stale items that can never succeed (for example deleted fluid IDs).
      if (
        error instanceof ApiRequestError &&
        (error.status === 400 ||
          error.status === 404 ||
          error.status === 409 ||
          (error.status === 500 && error.body.includes("23503")))
      ) {
        await cursor.delete();
      } else {
        throw error;
      }
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}
