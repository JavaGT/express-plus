// domains/session/handlers.mjs — user views.
//
// Entity-oriented API, not app.db handles. `User` is the framework-provided
// entity (auth is default-on, so a User entity exists). Typed field handles for
// the select projection — no magic strings. `getOrFail` is the baked-in 404.
import { User } from 'express-plus';

export async function userList(req, res) {
  const users = await User.findAll().select(User.id, User.username);
  res.json({ users });
}

export async function userPage(req, res) {
  const user = await User.getOrFail(req.params.id);  // throws 404 if absent
  res.json({ id: user.id, username: user.username });
}
