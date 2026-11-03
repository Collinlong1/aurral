import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { ChevronsDown, ChevronsUp, GripVertical } from "../../../components/icons";
import TooltipButton from "../../../components/TooltipButton";
import "./PlaylistReorderList.css";

export type ReorderTrack = {
  id: string;
  trackName?: string | null;
  artistName?: string | null;
};

function ReorderRow({
  track,
  position,
  count,
  disabled,
  onMove,
}: {
  track: ReorderTrack;
  position: number;
  count: number;
  disabled: boolean;
  onMove: (id: string, to: number) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: track.id, disabled });
  const title = track.trackName || "Track";

  return (
    <li
      ref={setNodeRef}
      className={`playlist-reorder__item${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="playlist-reorder__handle"
        aria-label={`Reorder ${title}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" />
      </button>
      <span className="playlist-reorder__number" aria-hidden="true">
        {position + 1}
      </span>
      <span className="playlist-reorder__copy">
        <span className="playlist-reorder__name">{title}</span>
        {track.artistName ? (
          <span className="playlist-reorder__artist">{track.artistName}</span>
        ) : null}
      </span>
      <TooltipButton
        className="playlist-reorder__move"
        label={`Move ${title} to the top`}
        aria-label={`Move ${title} to the top`}
        disabled={disabled || position === 0}
        onClick={() => onMove(track.id, 0)}
      >
        <ChevronsUp aria-hidden="true" />
      </TooltipButton>
      <TooltipButton
        className="playlist-reorder__move"
        label={`Move ${title} to the bottom`}
        aria-label={`Move ${title} to the bottom`}
        disabled={disabled || position === count - 1}
        onClick={() => onMove(track.id, count - 1)}
      >
        <ChevronsDown aria-hidden="true" />
      </TooltipButton>
    </li>
  );
}

// A playlist's tracks in a list you drag, or move with the keyboard, to put
// them in a new order. The parent keeps the order and saves it.
export function PlaylistReorderList<T extends ReorderTrack>({
  label,
  tracks,
  disabled = false,
  onChange,
}: {
  label: string;
  tracks: T[];
  disabled?: boolean;
  onChange: (tracks: T[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids: UniqueIdentifier[] = tracks.map((track) => track.id);
  const titleOf = (id: UniqueIdentifier) =>
    tracks.find((track) => track.id === id)?.trackName || "Track";
  const positionOf = (id: UniqueIdentifier) => `position ${ids.indexOf(id) + 1} of ${ids.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)} at ${positionOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${titleOf(active.id)} moved to ${positionOf(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over ? `${titleOf(active.id)} dropped at ${positionOf(over.id)}.` : undefined,
    onDragCancel: ({ active }) =>
      `Reordering cancelled. ${titleOf(active.id)} stays at ${positionOf(active.id)}.`,
  };

  const move = (id: UniqueIdentifier, to: number) => {
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || from === to) return;
    onChange(arrayMove(tracks, from, to));
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) move(active.id, ids.indexOf(over.id));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      accessibility={{ announcements }}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="playlist-reorder" aria-label={label}>
          {tracks.map((track, position) => (
            <ReorderRow
              key={track.id}
              track={track}
              position={position}
              count={tracks.length}
              disabled={disabled}
              onMove={move}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
