import {
  Check, Download, Heart, ListEnd, ListMusic, Pencil, Pin, Play, Plus, Search,
  SquareArrowOutUpRight, Trash2, X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useMenuFocus } from "../hooks/useMenuFocus";
import type { PlaylistSummary, SongSummary } from "../types";

type SelectionBarProps = {
  allLiked: boolean;
  allSelected: boolean;
  onAddToPlaylist: () => void;
  onClear: () => void;
  onEnqueue: () => void;
  onPlayNext: () => void;
  onSelectAll: () => void;
  onToggleLike: () => void;
  selectedCount: number;
};

/// Mirrors the iOS collection selection bar: Select All, Play Next, Add to
/// Queue and Like/Unlike over the chosen rows.
export function SelectionBar({
  allLiked, allSelected, onAddToPlaylist, onClear, onEnqueue, onPlayNext, onSelectAll, onToggleLike, selectedCount,
}: SelectionBarProps) {
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected songs">
      <span className="selection-bar__count">{selectedCount} selected</span>
      <button className="selection-bar__link" onClick={onSelectAll} type="button">{allSelected ? "Deselect all" : "Select all"}</button>
      <span className="selection-bar__spacer" />
      <button onClick={onPlayNext} type="button"><ListEnd size={16} /> Play next</button>
      <button onClick={onEnqueue} type="button"><ListMusic size={16} /> Add to queue</button>
      <button onClick={onAddToPlaylist} type="button"><Plus size={16} /> Add to playlist</button>
      <button onClick={onToggleLike} type="button"><Heart fill={allLiked ? "currentColor" : "none"} size={16} /> {allLiked ? "Unlike" : "Like"}</button>
      <button aria-label="Clear selection" className="selection-bar__close" onClick={onClear} type="button"><X size={17} /></button>
    </div>
  );
}

type AddToPlaylistDialogProps = {
  onCancel: () => void;
  onConfirm: (playlists: PlaylistSummary[]) => void;
  onCreate: () => void;
  playlists: PlaylistSummary[];
  songs: SongSummary[];
};

/// The iOS sheet takes several playlists at once and is searchable; the desktop
/// context menu used to cap silently at the first eight.
export function AddToPlaylistDialog({ onCancel, onConfirm, onCreate, playlists, songs }: AddToPlaylistDialogProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onCancel);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? playlists.filter((playlist) => playlist.name.toLowerCase().includes(needle)) : playlists;
  }, [playlists, query]);
  const label = songs.length === 1 ? songs[0].title : `${songs.length} songs`;

  return (
    <div className="modal-scrim">
      <div aria-labelledby="add-to-playlist-title" aria-modal="true" className="desktop-modal desktop-modal--list" ref={dialogRef} role="dialog">
        <p className="eyebrow">ADD TO PLAYLIST</p>
        <h2 id="add-to-playlist-title">{label}</h2>
        <label className="dialog-search">
          <Search aria-hidden="true" size={15} />
          <input aria-label="Find a playlist" autoFocus onChange={(event) => setQuery(event.target.value)} placeholder="Find a playlist" value={query} />
        </label>
        <div className="dialog-list">
          {matches.map((playlist) => {
            const picked = chosen.has(playlist.id);
            return (
              <button
                aria-pressed={picked}
                className={picked ? "dialog-list__row dialog-list__row--picked" : "dialog-list__row"}
                key={playlist.id}
                onClick={() => setChosen((current) => {
                  const next = new Set(current);
                  if (next.has(playlist.id)) next.delete(playlist.id); else next.add(playlist.id);
                  return next;
                })}
                type="button"
              >
                <span><strong>{playlist.name}</strong><small>{playlist.songCount ? `${playlist.songCount} songs` : "Playlist"}{playlist.owner ? ` · ${playlist.owner}` : ""}</small></span>
                <i aria-hidden="true">{picked && <Check size={15} />}</i>
              </button>
            );
          })}
          {!matches.length && <p className="dialog-list__empty">{playlists.length ? "No playlist matches that name." : "You have no playlists yet."}</p>}
        </div>
        <div>
          <button onClick={onCreate} type="button"><Plus size={15} /> New playlist</button>
          <span className="selection-bar__spacer" />
          <button onClick={onCancel} type="button">Cancel</button>
          <button
            className="modal-primary"
            disabled={!chosen.size}
            onClick={() => onConfirm(playlists.filter((playlist) => chosen.has(playlist.id)))}
            type="button"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

export type CollectionMenuState = {
  kind: "album" | "artist" | "playlist";
  id: string;
  name: string;
  x: number;
  y: number;
};

type CollectionMenuProps = {
  canEdit: boolean;
  menu: CollectionMenuState;
  onClose: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onEnqueue: () => void;
  onOpen: () => void;
  onPin: () => void;
  onPlay: () => void;
  onRename: () => void;
  onToggleStar: () => void;
  pinned: boolean;
  starred: boolean;
};

/// The shared collection action menu spec 3 asks for: the same set whether it
/// was opened from a card in the workspace or a row in the library rail.
export function CollectionMenu({
  canEdit, menu, onClose, onDelete, onDownload, onEnqueue, onOpen, onPin, onPlay, onRename, onToggleStar, pinned, starred,
}: CollectionMenuProps) {
  const menuRef = useMenuFocus(onClose);
  const style = { left: Math.max(8, Math.min(menu.x, window.innerWidth - 250)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 330)) };
  const stop = (action: () => void) => (event: ReactMouseEvent) => { event.stopPropagation(); action(); onClose(); };
  const isPlaylist = menu.kind === "playlist";
  return (
    <div className="context-menu" ref={menuRef} role="menu" style={style}>
      <strong className="context-menu__title">{menu.name}</strong>
      <button onClick={stop(onPlay)} role="menuitem" type="button"><Play fill="currentColor" size={15} />Play</button>
      {menu.kind !== "artist" && <button onClick={stop(onEnqueue)} role="menuitem" type="button"><ListMusic size={16} />Add to queue</button>}
      <button onClick={stop(onOpen)} role="menuitem" type="button"><SquareArrowOutUpRight size={15} />Open</button>
      {menu.kind !== "playlist" && <button onClick={stop(onToggleStar)} role="menuitem" type="button"><Heart fill={starred ? "currentColor" : "none"} size={16} />{menu.kind === "artist" ? (starred ? "Unfollow" : "Follow") : (starred ? "Remove from Liked" : "Save to Liked")}</button>}
      {menu.kind !== "artist" && <button onClick={stop(onDownload)} role="menuitem" type="button"><Download size={16} />Download</button>}
      <button onClick={stop(onPin)} role="menuitem" type="button"><Pin size={15} />{pinned ? "Unpin" : "Pin to top"}</button>
      {isPlaylist && canEdit && <>
        <span className="context-menu__separator" />
        <button onClick={stop(onRename)} role="menuitem" type="button"><Pencil size={15} />Rename</button>
        <button className="context-menu__danger" onClick={stop(onDelete)} role="menuitem" type="button"><Trash2 size={15} />Delete playlist</button>
      </>}
    </div>
  );
}
