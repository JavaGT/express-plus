// domains/session/handlers.mjs — user views.
//
// Entity-oriented API, not app.db handles. `User` is the framework-provided
// entity (auth is default-on, so a User entity exists). Typed field handles for
// the select projection — no magic strings.
import { User } from 'express-plus';

export async function userList(req, res) {
  const users = await User.findAll().select(User.id, User.username);
  res.json({ users });
}

export async function userPage(req, res, next) {
  const user = await User.get(req.params.id);
  if (!user) return next({ status: 404, message: 'no such user' });
  res.json({ id: user.id, username: user.username });
}
