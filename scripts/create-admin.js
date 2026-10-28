'use strict';

/**
 * Create (or promote) an administrator account.
 *   npm run create-admin -- you@school.ca "a-strong-password" "Your Name"
 */

require('dotenv').config();
const { db } = require('../server/db');
const auth = require('../server/auth');

const [email, password, name] = process.argv.slice(2);

if (!email || !password) {
	console.log('Usage: npm run create-admin -- <email> <password> [name]');
	process.exit(1);
}

const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
if (existing) {
	db.prepare("UPDATE users SET role = 'admin', has_access = 1 WHERE id = ?").run(existing.id);
	auth.setPassword(existing.id, password);
	console.log('Promoted ' + existing.email + ' to admin and updated the password.');
} else {
	const row = auth.createUser({ email, password, name: name || 'Administrator', role: 'admin', hasAccess: true });
	console.log('Created admin account ' + row.email);
}
