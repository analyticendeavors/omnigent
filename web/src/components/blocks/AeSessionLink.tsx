// Anchors that switch to another OmniGent session (`/c/<id>`) inside the app.
// Kept out of ChatMarkdown.tsx so the markdown callers that only need this
// anchor (reasoning, PR bodies) do not import the chat renderer.

import type React from "react";
import { useInRouterContext } from "react-router-dom";
import { sessionLinkRoute } from "@/lib/aeSessionLinks";
import { useSessionLinkTitle } from "@/lib/aeSessionTitles";
import { withBasePath } from "@/lib/basePath";
import { useLocation, useNavigate } from "@/lib/routing";
import { cn } from "@/lib/utils";

export const SESSION_LINK_CLASS = "wrap-anywhere font-medium text-link underline";

type AnchorProps = React.ComponentPropsWithoutRef<"a">;

/**
 * A link to another session. Only a plain primary click is taken over: the
 * incoming onClick runs first, then the router navigates. A modified click
 * (meta, ctrl, shift, alt, middle button) keeps the browser or Electron
 * default, and every other anchor attribute (target, rel, aria-*) is kept.
 * A link to the session already open navigates nowhere, so repeat clicks do
 * not stack history entries.
 *
 * A link whose text is the session URL itself (a bare autolink) shows the
 * session's title instead; an explicit `[text](url)` keeps its own text.
 */
export function SessionRouteLink({
  route,
  href,
  className,
  children,
  onClick,
  ...props
}: AnchorProps & { route: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Bare only when the text is the very session the href points at.
  const bare = typeof children === "string" && sessionLinkRoute(children.trim()) === route;
  const title = useSessionLinkTitle(route, bare);
  return (
    <a
      data-streamdown="link"
      {...props}
      href={href}
      className={cn(SESSION_LINK_CLASS, className)}
      data-ae-session-link=""
      title={props.title ?? (bare ? children : undefined)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (route === `${location.pathname}${location.search}${location.hash}`) return;
        navigate(route);
      }}
    >
      {title ?? children}
    </a>
  );
}

/**
 * Streamdown `a` override for markdown that has no file-link pass: a session
 * link routes in-app, any other link renders as Streamdown's own new-tab anchor.
 */
export function SessionAwareAnchor({
  href,
  children,
  className,
  node: _node,
  ...props
}: AnchorProps & { node?: unknown }) {
  const inRouter = useInRouterContext();
  const rebased = typeof href === "string" ? withBasePath(href) : href;
  const route = typeof rebased === "string" ? sessionLinkRoute(rebased) : null;
  if (route && inRouter) {
    return (
      <SessionRouteLink {...props} route={route} href={rebased} className={className}>
        {children}
      </SessionRouteLink>
    );
  }
  return (
    <a
      data-streamdown="link"
      rel="noreferrer"
      target="_blank"
      {...props}
      href={href}
      className={cn(SESSION_LINK_CLASS, className)}
    >
      {children}
    </a>
  );
}

/** Stable `components` map for Streamdown callers that only need session links. */
export const AE_SESSION_LINK_COMPONENTS = { a: SessionAwareAnchor };
