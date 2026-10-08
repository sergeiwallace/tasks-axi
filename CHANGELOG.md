# Changelog

## [0.3.0](https://github.com/sergeiwallace/tasks-axi/compare/tasks-axi-v0.2.6...tasks-axi-v0.3.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* **beads:** make the Beads graph the sole record

### Features

* **beads:** make the Beads graph the sole record ([88e9464](https://github.com/sergeiwallace/tasks-axi/commit/88e946486e99a70190a27cb8e5278cf1dfbdde67))
* **beads:** restore PR [#52](https://github.com/sergeiwallace/tasks-axi/issues/52)'s dep-pair conflict refusal ([d191e38](https://github.com/sergeiwallace/tasks-axi/commit/d191e38ab64d6d5fa78c1569c5cbac0f24e7a4bb))


### Bug Fixes

* **beads:** serialize every graph mutation behind an advisory lock ([31aa84a](https://github.com/sergeiwallace/tasks-axi/commit/31aa84ab32443dd2c3443bf294dec93d9044b5b5))
* **mv:** capture the failing removal's detail before the rollback runs ([ffbc57c](https://github.com/sergeiwallace/tasks-axi/commit/ffbc57c13e42ec8aa499150dbba75a90c09a05ac))
* **mv:** make the beads transfer contract honest and recoverable ([deee55b](https://github.com/sergeiwallace/tasks-axi/commit/deee55bdacb6c4504f96f8314d053f9bd144052c))
* **mv:** never let a transfer rollback strip a moved dependent's edge ([38a3121](https://github.com/sergeiwallace/tasks-axi/commit/38a3121da66717a57303ffdc8ffb772007aae999))
* **mv:** protect every represented edge type during transfer and rollback ([fdf2dea](https://github.com/sergeiwallace/tasks-axi/commit/fdf2dea793d9080885f82fd5a86b2116131f4777))
* **mv:** refuse a destination dir that HOLDS a beads graph, not just one named .beads ([8e2e09a](https://github.com/sergeiwallace/tasks-axi/commit/8e2e09a03ba861c8d2e28c0aaea7076cffac4811))
* **mv:** refuse to transfer a public obligation between beads graphs ([0b29557](https://github.com/sergeiwallace/tasks-axi/commit/0b295576637c1916bf09832402805924d0d1d5f9))

## [0.2.6](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.2.5...tasks-axi-v0.2.6) (2026-09-22)


### Bug Fixes

* **cli:** accept canonical Forgejo pull request URLs ([#36](https://github.com/kunchenguid/tasks-axi/issues/36)) ([9a86c7c](https://github.com/kunchenguid/tasks-axi/commit/9a86c7c86a4617a5a4f00f28dcb9588b03897f8f))
* make failed public follow-ups deliverable ([#67](https://github.com/kunchenguid/tasks-axi/issues/67)) ([603c901](https://github.com/kunchenguid/tasks-axi/commit/603c9018fb08859675b28e5e3816906c2b74561c))
* make the generated skill defer to live CLI guidance ([#48](https://github.com/kunchenguid/tasks-axi/issues/48)) ([d9175b6](https://github.com/kunchenguid/tasks-axi/commit/d9175b6d083d693c5b6ca21652454d52e4b312d9))

## [0.2.5](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.2.4...tasks-axi-v0.2.5) (2026-08-07)


### Bug Fixes

* **cli:** speed up standalone version queries ([#34](https://github.com/kunchenguid/tasks-axi/issues/34)) ([92911b2](https://github.com/kunchenguid/tasks-axi/commit/92911b2e0cc4ddfd6bafee977cca369bab7e165c))

## [0.2.4](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.2.3...tasks-axi-v0.2.4) (2026-07-23)


### Bug Fixes

* execute every PR body compliance event ([#22](https://github.com/kunchenguid/tasks-axi/issues/22)) ([ce32241](https://github.com/kunchenguid/tasks-axi/commit/ce322417a186a90bfa6ff27e4e2243789166db09))

## [0.2.3](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.2.2...tasks-axi-v0.2.3) (2026-07-13)


### Features

* add durable public follow-up obligations ([#16](https://github.com/kunchenguid/tasks-axi/issues/16)) ([d7845d3](https://github.com/kunchenguid/tasks-axi/commit/d7845d3b3dc1cbf084909e127c1a65f3abac2fce))

## [0.2.2](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.2.1...tasks-axi-v0.2.2) (2026-07-10)


### Features

* move linked task sets atomically ([#13](https://github.com/kunchenguid/tasks-axi/issues/13)) ([f75ebbd](https://github.com/kunchenguid/tasks-axi/commit/f75ebbd9faf92c1eb4cc8aa958ad5f37607ea677))

## [0.2.1](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.2.0...tasks-axi-v0.2.1) (2026-07-10)


### Bug Fixes

* **markdown:** preserve blank lines in task bodies ([#11](https://github.com/kunchenguid/tasks-axi/issues/11)) ([0229c56](https://github.com/kunchenguid/tasks-axi/commit/0229c5611b7ab23b8ff54cf08c7ca337b508f840))

## [0.2.0](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.1.2...tasks-axi-v0.2.0) (2026-07-08)


### ⚠ BREAKING CHANGES

* **commands:** tasks-axi update no longer accepts --append. Agents must inspect the current body and replace it with --body or --body-file, optionally passing --archive-body to preserve the superseded body in note-archive.md.

### Features

* add structured task holds ([#8](https://github.com/kunchenguid/tasks-axi/issues/8)) ([0f283ed](https://github.com/kunchenguid/tasks-axi/commit/0f283ed3d988a7ecd9cd12d325ac4b5f4f68007b))
* **commands:** replace append notes with body replacement archival ([#10](https://github.com/kunchenguid/tasks-axi/issues/10)) ([a7993d2](https://github.com/kunchenguid/tasks-axi/commit/a7993d2a8e8b56f1f66d125fd057de1587b62c80))

## [0.1.2](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.1.1...tasks-axi-v0.1.2) (2026-06-29)


### Features

* **cli:** add confirmation-forward mutation output ([#6](https://github.com/kunchenguid/tasks-axi/issues/6)) ([6d39143](https://github.com/kunchenguid/tasks-axi/commit/6d39143e14bfef6711a31371129343b23f97bf0e))

## [0.1.1](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.1.0...tasks-axi-v0.1.1) (2026-06-23)


### Features

* add markdown-backed tasks-axi CLI ([#1](https://github.com/kunchenguid/tasks-axi/issues/1)) ([239b320](https://github.com/kunchenguid/tasks-axi/commit/239b32046222c1e176390e592f28232f2dc69684))
* **backends:** round-trip firstmate backlog format ([#4](https://github.com/kunchenguid/tasks-axi/issues/4)) ([891555c](https://github.com/kunchenguid/tasks-axi/commit/891555ccb7e694e359ab9b2c0f70f5f2af3c065d))
