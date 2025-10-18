export interface UndoRedoCommand {
  redo: () => void;
  undo: () => void;
  label?: string;
}

export interface UndoRedoManager {
  execute: (command: UndoRedoCommand) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  history: () => { undo: readonly UndoRedoCommand[]; redo: readonly UndoRedoCommand[] };
}

export const createUndoRedo = (capacity = 100): UndoRedoManager => {
  const undoStack: UndoRedoCommand[] = [];
  const redoStack: UndoRedoCommand[] = [];

  return {
    execute(command: UndoRedoCommand) {
      command.redo();
      undoStack.push(command);
      if (undoStack.length > capacity) {
        undoStack.shift();
      }
      redoStack.length = 0;
    },
    undo() {
      const command = undoStack.pop();
      if (!command) return;
      command.undo();
      redoStack.push(command);
    },
    redo() {
      const command = redoStack.pop();
      if (!command) return;
      command.redo();
      undoStack.push(command);
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    history() {
      return { undo: [...undoStack], redo: [...redoStack] };
    },
  };
};
