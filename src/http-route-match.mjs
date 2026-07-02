function matchPath(template, actual) {
  const t = template.split('/').filter(Boolean);
  const a = actual.split('/').filter(Boolean);
  if (t.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < t.length; i += 1) {
    if (t[i].startsWith(':')) {
      params[t[i].slice(1)] = decodeURIComponent(a[i]);
    } else if (t[i] !== a[i]) {
      return null;
    }
  }
  return params;
}

function specificity(template) {
  return template.split('/').filter((s) => s && !s.startsWith(':')).length;
}

export function matchRoute(routes, method, pathname) {
  let pathMatched = false;
  let best = null;
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
