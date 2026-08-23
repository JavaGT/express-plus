export type RouteParams = Record<string, string>;

export interface RouteDefinition {
  method: string;
  path: string;
  [key: string]: unknown;
}

export type RouteMatch =
  | { route: RouteDefinition; params: RouteParams }
  | { route: null; params: null; pathMatched: boolean };

function matchPath(template: string, actual: string): RouteParams | null {
  const t = template.split('/').filter(Boolean);
  const a = actual.split('/').filter(Boolean);
  if (t.length !== a.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < t.length; i += 1) {
    if (t[i].startsWith(':')) {
      try {
        params[t[i].slice(1)] = decodeURIComponent(a[i]);
      } catch (error) {
        if (error instanceof URIError) return null;
        throw error;
      }
    } else if (t[i] !== a[i]) {
      return null;
    }
  }
  return params;
}

function specificity(template: string): number {
  return template.split('/').filter((s) => s && !s.startsWith(':')).length;
}

interface ScoredMatch {
  route: RouteDefinition;
  params: RouteParams;
  score: number;
}

export function matchRoute(
  routes: readonly RouteDefinition[],
  method: string,
  pathname: string,
): RouteMatch {
  let pathMatched = false;
  let best: ScoredMatch | null = null;
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params === null) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    const score = specificity(route.path);
    if (!best || score > best.score) best = { route, params, score };
  }
  return best ? { route: best.route, params: best.params } : { route: null, params: null, pathMatched };
}
