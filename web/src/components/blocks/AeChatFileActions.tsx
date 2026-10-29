// Open and Download for a file a chat reply names (inline code or a markdown
// link). Right-click, the context-menu key and Shift+F10 open a small menu;
// touch screens, which have no right-click, get a download icon after the name.

import { useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { showToast } from "@/components/ui/toast";
import { downloadWorkspaceFile } from "@/hooks/useFileContent";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import { AeTablerSvg } from "@/lib/aeTablerIcon";

/** Tabler `download` (outline, @tabler/icons 3.46.0), inlined. */
const AE_DOWNLOAD_ICON: AeTablerIconNode = [
  ["path", { d: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" }],
  ["path", { d: "M7 11l5 5l5 -5" }],
  ["path", { d: "M12 4l0 12" }],
];

const COARSE = "(pointer: coarse)";

function subscribeCoarse(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(COARSE);
  query.addEventListener?.("change", callback);
  return () => query.removeEventListener?.("change", callback);
}

function isCoarse(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(COARSE).matches;
}

export interface AeChatFileActions {
  onContextMenu: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  /** The title text: the right-click hint is added on fine pointers only. */
  hint: (base: string) => string;
  /** The menu; render it inside the link (it is portaled and stops its events). */
  extra: ReactNode;
  /** The touch download icon; render it as a sibling after the link. */
  after: ReactNode;
}

export function useAeChatFileActions(
  conversationId: string | undefined,
  resolvedPath: string,
  onOpen: (() => void) | null,
): AeChatFileActions {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const coarse = useSyncExternalStore(subscribeCoarse, isCoarse, () => false);
  if (!conversationId || !resolvedPath || !onOpen) {
    return { onContextMenu: undefined, hint: (base) => base, extra: null, after: null };
  }

  const download = () => {
    // Only the native-shell blob path can reject; a desktop download resolves before any response.
    downloadWorkspaceFile(conversationId, resolvedPath).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      showToast(
        `Download failed: ${message}. If the chat is asleep, send it a message and try again.`,
      );
    });
  };
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    // A keyboard-opened menu has no pointer position; anchor it to the link.
    const box = event.currentTarget.getBoundingClientRect();
    setPoint({ x: event.clientX || box.left, y: event.clientY || box.bottom });
  };
  const name = resolvedPath.split("/").pop() ?? resolvedPath;
  const menu =
    point &&
    createPortal(
      <DropdownMenu open modal={false} onOpenChange={(open) => !open && setPoint(null)}>
        <DropdownMenuTrigger asChild>
          <span className="fixed" style={{ left: point.x, top: point.y }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(event) => event.preventDefault()}
          // The menu is portaled but still a React child of the link: keep its events off the link.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <DropdownMenuItem onSelect={onOpen}>Open</DropdownMenuItem>
          <DropdownMenuItem onSelect={download}>Download</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
      document.body,
    );
  const after = coarse ? (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Download ${name}`}
      title={`Download ${name}`}
      className="inline-block size-[1em] align-[-0.125em] ml-0.5 cursor-pointer"
      onClick={(event) => {
        event.stopPropagation();
        download();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          download();
        }
      }}
    >
      <AeTablerSvg node={AE_DOWNLOAD_ICON} className="size-full" />
    </span>
  ) : null;
  const hint = (base: string) => (coarse ? base : `${base} (right-click for Download)`);
  return { onContextMenu, hint, extra: menu, after };
}
