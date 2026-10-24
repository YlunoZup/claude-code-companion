// Static checks on the repository itself.
//
// These are the checks that executing the code on one platform cannot reveal —
// a CRLF that only breaks on Linux, a package.json field that only breaks the
// installed copy, a path referenced by the installer that nobody ships.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers.test.mjs";

const SHELL_FILES = ["install.sh", join("bin", "ccc")];
const BATCH_FILES = ["install.bat", join("bin", "ccc.bat")];
const SOURCE_FILES = [
  join("src", "profiles.cjs"),
  join("src", "picker.mjs"),
  join("src", "usage.cjs"),
  join("src", "statusline.js"),
  join("src", "chatgpt.cjs"),
  join("src", "translate.cjs"),
  join("src", "router.cjs"),
];

const read = (f) => readFileSync(join(REPO_ROOT, f), "utf8");

describe("line endings", () => {
  // A lone \r in a bash script is fatal on Linux and macOS: the shell reports
  // "$'\r': command not found" and the install dies on line one. Git for
  // Windows defaults to core.autocrlf=true, so without .gitattributes a Windows
  // clone produces exactly that.
  for (const file of [...SHELL_FILES, ...SOURCE_FILES]) {
    test(`${file} has no carriage returns`, () => {
      assert.equal((read(file).match(/\r/g) || []).length, 0);
    });
  }

  for (const file of BATCH_FILES) {
    test(`${file} uses CRLF, which is what cmd.exe wants`, () => {
      const content = read(file);
      const crlf = (content.match(/\r\n/g) || []).length;
      const bareLf = (content.match(/(?<!\r)\n/g) || []).length;
      assert.ok(crlf > 0, "expected CRLF line endings");
      assert.equal(bareLf, 0, "found bare LF line endings");
    });
  }

  test(".gitattributes pins the rules that keep it that way", () => {
    const attrs = read(".gitattributes");
    assert.match(attrs, /\*\.sh\s+text\s+eol=lf/);
    assert.match(attrs, /bin\/ccc\s+text\s+eol=lf/);
    assert.match(attrs, /\*\.bat\s+text\s+eol=crlf/);
  });
});

describe("no invisible glyphs in the sources", () => {
  // A Powerline or Nerd Font glyph pasted in literally is a private-use
  // character: invisible in most editors, and easily stripped by a tool without
  // anybody noticing. Write it as a \uXXXX escape instead.
  for (const file of [...SHELL_FILES, ...BATCH_FILES, ...SOURCE_FILES]) {
    test(`${file} has no private-use characters`, () => {
      const found = [...read(file)].filter((c) => c >= "\uE000" && c <= "\uF8FF");
      assert.deepEqual(found.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`), []);
    });
  }
});

describe("shell syntax", () => {
  for (const file of SHELL_FILES) {
    test(`${file} parses`, () => {
      const r = spawnSync("bash", ["-n", join(REPO_ROOT, file)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    });
  }
});

describe("packaging", () => {
  // statusline.js is CommonJS. Declaring the repo as ESM would break it here
  // while leaving the installed copy working — a CI result that lies.
  test("package.json does not declare the project as ESM", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.notEqual(pkg.type, "module", "statusline.js is CommonJS and would stop loading");
  });

  test("package.json runs the test suite", () => {
    assert.equal(JSON.parse(read("package.json")).scripts.test, "node --test");
  });

  test("the declared Node floor matches the README", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.engines && pkg.engines.node, "engines.node should be declared");
    const floor = pkg.engines.node.replace(/[^\d]/g, "").slice(0, 2);
    assert.match(read("README.md"), new RegExp(`v${floor}\\+`), "README should state the same floor");
  });
});

describe("the installers ship what they reference", () => {
  const referenced = [
    join("src", "profiles.cjs"),
    join("src", "picker.mjs"),
    join("src", "usage.cjs"),
    join("src", "statusline.js"),
    "config.example.json",
    join("bin", "ccc"),
    join("bin", "ccc.bat"),
  ];

  for (const file of referenced) {
    test(`${file} exists`, () => {
      assert.ok(existsSync(join(REPO_ROOT, file)));
    });
  }

  // setx PATH collapses the machine and user PATH into one user variable and
  // truncates it at 1024 characters. install.bat names it only to warn
  // against it, which is why a bare pattern match is not enough here.
  test("install.bat never recommends setx PATH", () => {
    const mentions = read("install.bat")
      .split(/\r?\n/)
      .filter((line) => /setx\s+PATH/i.test(line));
    for (const line of mentions) {
      assert.match(line, /\bavoid\b/i, `recommends setx: ${line.trim()}`);
    }
  });

  test("install.sh and install.bat copy the same set of files", () => {
    const sh = read("install.sh");
    const bat = read("install.bat");
    for (const name of ["profiles.cjs", "picker.mjs", "usage.cjs", "statusline.js", "config.example.json"]) {
      assert.ok(sh.includes(name), `install.sh never mentions ${name}`);
      assert.ok(bat.includes(name), `install.bat never mentions ${name}`);
    }
  });
});

describe("no credentials in the tree", () => {
  // The project deliberately never reads a secret — the Keychain probe is
  // attribute-only and .credentials.json is only checked for existence. Nothing
  // resembling a real token should ever be committed here.
  const SECRET_PATTERNS = [
    [/sk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic API key"],
    [/ghp_[A-Za-z0-9]{36}/, "a GitHub token"],
    [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, "a private key"],
    [/"access_token"\s*:\s*"[A-Za-z0-9._-]{20,}"/, "an OAuth access token"],
  ];

  const FILES = [
    ...SHELL_FILES,
    ...BATCH_FILES,
    ...SOURCE_FILES,
    "README.md",
    "config.example.json",
    "package.json",
  ];

  for (const file of FILES) {
    test(`${file} contains no secrets`, () => {
      const content = read(file);
      for (const [pattern, what] of SECRET_PATTERNS) {
        assert.doesNotMatch(content, pattern, `${file} looks like it contains ${what}`);
      }
    });
  }

  test("the login check never asks the Keychain for a secret value", () => {
    const lib = read(join("src", "profiles.cjs"));
    assert.ok(lib.includes("find-generic-password"), "expected the attribute-only probe");
    assert.doesNotMatch(
      lib,
      /find-generic-password[^)]*"-w"/,
      "-w would read the secret and trigger a Keychain prompt"
    );
  });

  // Live usage comes from Claude Code itself, which handles the token. Reading
  // one here would also mean refreshing it here, racing Claude Code.
  test("live usage never touches a credential", () => {
    for (const file of [join("src", "usage.cjs"), join("src", "picker.mjs")]) {
      const source = read(file);
      assert.doesNotMatch(source, /security|\.credentials\.json|accessToken|refreshToken/, file);
    }
  });
});

describe("no inline JavaScript left in the shell and batch scripts", () => {
  // Interpolating a path into `node -e` source is how a home directory
  // containing a quote used to break ccc, and how `!` inside a JS snippet got
  // eaten by cmd's delayed expansion. Everything goes through profiles.cjs now.
  const stripComments = (content) =>
    content
      .split("\n")
      .filter((line) => !/^\s*(#|::|rem\s)/i.test(line))
      .join("\n");

  for (const file of [...SHELL_FILES, ...BATCH_FILES]) {
    test(`${file} has no node -e snippet`, () => {
      assert.doesNotMatch(
        stripComments(read(file)),
        /node\s+-e/,
        "use a profiles.cjs subcommand instead"
      );
    });
  }
});
