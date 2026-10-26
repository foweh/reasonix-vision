import type { Card } from "./cards.js";
import type { AgentEvent } from "./events.js";
import { reduce } from "./reducer.js";
import { type AgentState, type SessionInfo, initialState } from "./state.js";

export type StateListener = () => void;
export type EventListener = (event: AgentEvent) => void;

export interface AgentStore {
  getState(): AgentState;
  dispatch(event: AgentEvent): void;
  subscribe(listener: StateListener): () => void;
  onEvent(listener: EventListener): () => void;
}

export function createStore(session: SessionInfo, initialCards?: ReadonlyArray<Card>): AgentStore {
  let state = initialState(session, initialCards);
  const stateListeners = new Set<StateListener>();
  const eventListeners = new Set<EventListener>();

  return {
    getState() {
      return state;
    },
    dispatch(event) {
      state = reduce(state, event);
      for (const listener of stateListeners) listener();
      for (const listener of eventListeners) listener(event);
    },
    subscribe(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
  };
}
