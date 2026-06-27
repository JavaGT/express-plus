// domains/session/handlers.mjs — user views.
//
// userList powers both GET /users (authed) and the app-level home page; userPage
// renders a single user. These were referenced-but-undefined in the baseline
// app.mjs; kept as the thinnest faithful implementations.
import { app } from 'express-plus';

export async function userList(req, res) {
  const users = await app.db.users.all();
  res.json({ users: users.map((u) => ({ id: u.id, username: u.username })) });
}

export async function userPage(req, res, next) {
  const user = await app.db.users.find(req.params.id);
  if (!user) return next({ status: 404, message: 'no such user' });
  res.json({ id: user.id, username: user.username });
}
