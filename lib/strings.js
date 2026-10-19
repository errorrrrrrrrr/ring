'use strict';
/* ── User-facing copy (spec 14: English, keyed from day one) ──────────────────
 * Every sentence a person reads, in an API error, a mail or a page, is a row
 * here and is reached through t(key, vars). `{name}` placeholders are filled from
 * vars. No em dashes in any value (test/copy.test.js holds it).
 *
 * API errors answer `{ error: <key>, message: t(key) }`: the key is the contract
 * a client branches on, the message is what it may show.
 */

const EN = {
  // ── generic ──
  not_signed_in: 'Sign in first.',
  not_found: 'Not found.',
  csrf: 'This request came from another site and was refused.',
  bad_json: 'The request body is not valid JSON.',
  json_required: 'Send this request as application/json.',
  too_large: 'That request is too large.',
  rate_minute: 'Too many requests. Try again in a minute.',
  rate_hour: 'Too many requests. Try again within the hour.',
  rate_day: 'Daily limit reached. Try again tomorrow.',
  server_error: 'Something went wrong on the server.',
  forbidden: 'You cannot do that.',
  busy: 'The server is busy. Try again in a few seconds.',
  bad_request: 'That request could not be read.',
  upload_in_progress: 'Your previous upload is still being processed. Wait for it to finish.',

  // ── federation (P5) ──
  signature_invalid: 'This request is not signed, or its signature could not be verified.',
  activity_media_type: 'Send activities as application/activity+json or application/ld+json.',
  resource_required: 'Ask for a resource, such as acct:name@host.',

  // ── accounts ──
  check_email: 'Check your email for a link to continue.',
  mail_unavailable: 'This server cannot send mail yet, so it cannot take signups or password resets.',
  email_invalid: 'Enter a valid email address.',
  password_short: 'Use a password of at least 10 characters.',
  password_long: 'That password is too long.',
  name_invalid: 'A name is 1 to 30 lowercase letters, numbers or inner hyphens.',
  name_unavailable: 'That name is taken or reserved.',
  display_name_invalid: 'A display name is 1 to 60 characters.',
  invite_required: 'Signing up here needs an invite.',
  invite_invalid: 'That invite was used, revoked or has expired.',
  token_invalid: 'This link is invalid, was already used or has expired.',
  email_taken: 'An account with that email already exists. Sign in instead.',
  invalid_credentials: 'Email or password is wrong.',
  too_many_attempts: 'Too many attempts for this account. Try again later.',
  suspended: 'This account is suspended.',
  wrong_password: 'That password is wrong.',
  password_mismatch: 'Enter the password you chose when you signed up. If you did not sign up with it, ignore this link.',
  password_changed: 'Your password changed while this was in progress. Sign in again and retry.',
  last_admin: 'You are the last admin. Make someone else admin first.',
  invite_limit: 'You have {n} live invites already. Revoke one or wait for one to be used.',
  invites_off: 'Invites are switched off on this server.',

  // ── posts and page ──
  unknown_kind: 'That kind of post does not exist here.',
  empty_post: 'That post is empty.',
  bad_href: 'Links must start with http:// or https://.',
  bad_embed: 'Embeds work with YouTube, Vimeo and SoundCloud links.',
  foreign_image: 'You can only use images you uploaded.',
  not_in_ring: 'You are not in that ring.',
  archive_refused: 'Posts reach the archive by themselves after a week in a ring.',
  posts_full: 'Your page holds {n} posts. Delete some first.',
  invalid_field: 'One of the fields is not valid.',

  // ── the social layer (P2) ──
  own_post: 'That is your own post.',
  stamp_invalid: 'That is not a stamp.',
  custom_room_only: 'Custom stamps live in rings only.',
  friends_only: 'That face is for friends. Pick one from the nice shelf.',
  stamps_closed: 'Stamps are closed here.',
  comments_friends_only: 'Comments are for friends.',
  comments_closed: 'Comments are closed here.',
  comment_empty: 'Nothing to say?',
  page_off: 'Turn your page on before sending a post to Public.',
  own_handle: 'That is you.',
  blocked_them: 'You blocked them. Unblock them first.',
  follow_limit: 'You follow as many people as this server allows.',
  friend_limit: 'You have as many friends as this server allows.',
  follower_limit: 'You have as many followers as this server allows.',
  ring_name_required: 'Give the ring a name.',
  ring_limit: 'You are already in 3 rings. Leave one first.',
  ring_limit_them: 'They are already in 3 rings.',
  ring_full: 'That ring is full. A ring holds 6, people asking included.',
  ring_creator_only: 'Only the ring\u2019s creator can do that.',
  leave_instead: 'Leave the ring instead.',
  join_expired: 'That join link has expired. Make a new one and ask them to ask again.',
  // P7: rings across servers
  ring_server_only: 'That link is not on a Ring server. Rings are shared between Ring servers only.',
  ring_blocked: 'Someone in this ring has blocked them. The request was declined.',
  // P8: moderation
  reports_full: 'The report queue is full. Try again later.',
  host_invalid: 'That is not a host name, such as example.social.',
  handle_invalid: 'That is not a handle, such as name@example.social.',
  block_limit: 'This server blocks as many as it can hold. Remove one first.',
  own_host: 'That is this server.',
  nothing_to_remove: 'That report names nothing of this server that can be removed this way, or it is gone already.',
  report_closed: 'That report is closed. Reopen it first.',
  report_open: 'That report is open already.',
  not_local: 'That action is for a member of this server.',
  not_remote: 'That action is for someone on another server.',
  already_forwarded: 'That report was sent to their server already.',
  not_forwardable: 'This server does not know where to send that report.',
  'page.forbidden.title': 'Not for you',
  'page.forbidden.body': 'This page is for the server\u2019s admins.',

  // ── images ──
  no_file: 'Choose an image to upload.',
  unsupported_image: 'That file is not a supported image (JPEG, PNG, GIF or WebP).',
  image_too_large: 'Images must be under {mb} MB.',
  too_many_pixels: 'That image is too large to process: over {mp} megapixels. Export it smaller and try again.',
  image_failed: 'That image could not be processed. Try exporting it again.',
  storage_full: 'Your storage is full. Delete some posts with images first.',
  export_too_large: 'This export would be over {mb} MB, more than one download can carry.',
  export_busy: 'Other exports are being made right now. Try again in a minute.',

  // ── mail ──
  'mail.confirm.subject': 'Confirm your Ring account on {host}',
  'mail.confirm.body': 'Hello {display_name},\n\nOpen this link to finish signing up as {name} on {host}:\n\n{url}\n\nThe link works once and expires in 24 hours. If you did not sign up, ignore this mail.\n',
  'mail.exists.subject': 'Your Ring account on {host}',
  'mail.exists.body': 'Someone, maybe you, tried to sign up on {host} with this email address. It already has an account.\n\nSign in at {login}\nForgot the password? Reset it at {reset}\n\nIf this was not you, ignore this mail.\n',
  'mail.reset.subject': 'Reset your Ring password on {host}',
  'mail.reset.body': 'Open this link to choose a new password for {name} on {host}:\n\n{url}\n\nThe link works once and expires in an hour. Resetting signs you out everywhere. If you did not ask for this, ignore this mail.\n',

  // ── pages (spec 11.3; the wall arrives in P4) ──
  'page.index.title': 'Ring',
  'page.index.body': 'A small register of artists’ walls: post, stamp, and keep a ring of up to six.',
  'page.index.signin': 'Sign in',
  'page.index.signup': 'Sign up',
  'page.index.invite_only': 'Signing up here takes an invite from a member.',
  'page.notfound.title': 'Not found',
  'page.notfound.body': 'Nothing here.',
  'page.login.title': 'Sign in',
  'page.login.email': 'Email',
  'page.login.password': 'Password',
  'page.login.submit': 'Sign in',
  'page.login.working': 'Signing in...',
  'page.login.forgot': 'Forgot the password?',
  'page.login.signup': 'Have an invite? Sign up',
  'page.signup.title': 'Sign up',
  'page.signup.invite': 'Invite code (from your invite link)',
  'page.signup.invite_held': 'Your invite is in this link.',
  'page.signup.email': 'Email',
  'page.signup.name': 'Name',
  'page.signup.name_hint': 'Your page will be /@name. Lowercase letters, numbers and inner hyphens, up to 30. It can never change.',
  'page.signup.name_free': 'Available.',
  'page.signup.name_taken': 'Taken or reserved.',
  'page.signup.display_name': 'Display name (how your name is shown)',
  'page.signup.password': 'Password (10 characters or more)',
  'page.signup.submit': 'Sign up',
  'page.signup.working': 'Sending...',
  'page.signup.login': 'Already a member? Sign in',
  'page.confirm.title': 'Confirm your account',
  'page.confirm.label': 'The password you chose when you signed up',
  'page.confirm.submit': 'Confirm and sign in',
  'page.confirm.working': 'Confirming...',
  'page.confirm.done': 'Done. You are signed in.',
  'page.confirm.open': 'Open your Ring',
  'page.reset.title': 'Choose a new password',
  'page.reset.label': 'New password (10 characters or more)',
  'page.reset.submit': 'Set password',
  'page.reset.done': 'Password changed. Sign in again.',
  'page.reset.login': 'Sign in',
  'page.forgot.title': 'Forgot the password',
  'page.forgot.body': 'Type the email you signed up with. If it has an account here, a link to choose a new password is on its way; it works once, for an hour.',
  'page.forgot.label': 'Email',
  'page.forgot.submit': 'Mail me a link',
  'page.forgot.working': 'Sending...',
  'page.forgot.login': 'Back to sign in',
  'page.app.unbuilt.title': 'The composer is not built',
  'page.app.unbuilt.body': 'This server runs from a checkout without its composer bundle. Run npm run build, then reload.',
  'page.home': 'Home',
  // /authorize_interaction/remote (P6, spec 8.5): a visitor from another server
  'page.interact.title': 'From your server',
  'page.interact.body': 'Follow or stamp this from your own account on another server. Type your handle there.',
  'page.interact.label': 'Your handle (name@server)',
  'page.interact.submit': 'Continue',
  'page.interact.invalid': 'Type your handle as name@server.',
  'page.interact.go_title': 'Continue on {host}',
  'page.interact.go_body': 'The next page is on {host}, the server of {handle}. It asks you there to follow or stamp this. Go on only if {host} is your server.',
  'page.interact.go': 'Go to {host}',
  'page.interact.back': 'Back',
  'page.interact.join_body': 'Ask to join this ring from your own account on another Ring server. Type your handle there. Its members approve; your server, and every server already in the ring, then hold copies of the room\u2019s posts and are trusted to delete them after a week.',
  'page.interact.join_here': 'Have an account on this server? Sign in.',
  'page.interact.unknown': 'Your server could not be reached, or it does not offer this. Check the handle and try again.',
  interact_origin: 'This form was not sent from this site.',

  // ── the wall, /@name and /@name.rss (P4; the wall's own words: public/assets/strings.en.json) ──
  'page.wall.title': '{name} ({handle})',
  'page.wall.description': 'The wall of {name}: notes, pictures and links.',
  'page.wall.hello': 'hello, my name is',
  'page.wall.avatar_alt': 'The picture {name} chose',
  'page.wall.edit': 'edit in the app ✎',
  'page.wall.loading': 'Pinning things up...',
  'page.wall.noscript': 'The posts on this wall need JavaScript. The feed carries them too:',
  'page.wall.rss': 'RSS',
  'page.wall.rss_title': '{name}, the wall',
  'page.wall.rss_untitled': 'A post',
  'page.wall.made_with': 'a Ring wall on {host}',
};

const warned = new Set();

function t(key, vars) {
  let s = EN[key];
  if (s === undefined) {
    if (!warned.has(key)) { warned.add(key); console.error(`[strings] missing key: ${key}`); }
    return key;
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
  return s;
}

const has = (key) => Object.hasOwn(EN, key);

module.exports = { t, has, EN };
