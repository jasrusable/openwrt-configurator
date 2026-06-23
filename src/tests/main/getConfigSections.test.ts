import test from "ava";
import { parseSections } from "../../getConfigSections";

// Mimics `uci export`: a leading `package` line, then `config <type> ['name']`
// sections (named sections are quoted, anonymous ones are not), with option
// lines tab-indented.
const uciExport = `package firewall

config defaults
	option input 'REJECT'

config rule 'allow_ssh'
	option dest_port '22'

package network

config interface 'lan'
	option proto 'static'

config device
	option name 'br-lan'

package qosify

config defaults
	option dscp_prio 'video'

config class 'besteffort'
	option ingress 'CS0'

config interface 'wan'
	option mode 'diffserv4'

config device 'wandev'
	option disabled '1'
`;

test("parseSections attributes shared section types to every package", (t) => {
  const sections = parseSections(uciExport);

  // The regression: `defaults` (firewall+qosify) and `interface`/`device`
  // (network+qosify) must not be stolen by the first package that uses them.
  t.deepEqual(sections.firewall, ["defaults", "rule"]);
  t.deepEqual(sections.network, ["interface", "device"]);
  t.deepEqual(sections.qosify, ["defaults", "class", "interface", "device"]);
});

test("parseSections dedupes repeated section types within a package", (t) => {
  const sections = parseSections(
    `package firewall

config rule 'a'

config rule 'b'

config zone 'lan'
`
  );

  t.deepEqual(sections.firewall, ["rule", "zone"]);
});
