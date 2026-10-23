// File: cloud/config.js · deploy-time switches for cloud/main.js. Upload it next to main.js (Dashboard → Cloud Code).
// If the file is missing on the server, main.js falls back to the defaults shown here.
'use strict';

module.exports = {
  // Enables the privileged helpers in main.js: setupSchema (the _User class-level permissions + hasPassword field),
  // testCleanup (deletes the users the test suite / measure script created) and testWidenAcl (the ACL-misconfiguration
  // test). They run with the master key INSIDE Cloud Code, so scripts and tests never need the master key themselves —
  // but while this is true, anyone holding the app id + REST/JS key can call them. Leave it true while you set up and
  // verify the backend; set it to false and redeploy before the app has real users. Prove it with the curl in the README.
  SETUP_ENABLED: true,
};
