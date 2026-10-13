// VPN › Sites: other places linked over WireGuard, each reaching the other's
// networks as access allows. Linking two sites both run by this app is a
// copy and paste of each one's invitation into the other.
import { Alert, Button, Code, CopyButton, Group, Text, Textarea, TextInput } from "@mantine/core";
import { IconBuildingCommunity } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { where } from "../../../../src/intent/places";
import { Intent } from "../../../../src/intent/schema";
import { decodeInvite, encodeInvite, inviteOf, vpnEndpoint } from "../../../../src/intent/vpn";
import { newPrivateKey } from "../../../../src/wireguard";
import { useDraft, useDraftValue } from "../../form/draft";
import { NumberField, TagsField, TextField, Value } from "../../form/fields";
import { defineList, ListPage } from "../../form/ListPage";
import { ItemIcon, ItemName, Section, SettingRow, SettingsPage } from "../../kit/layout";
import { Experimental, ZoneAccess } from "./shared";

type Site = Intent["vpn"]["sites"]["peers"][number];

const NewSitePage = () => {
  const navigate = useNavigate();
  const draft = useDraft();
  const intent: Intent = useDraftValue();
  const [code, setCode] = useState("");
  const [site, setSite] = useState<Omit<Site, "id">>({ name: "", public_key: "", subnets: [] });
  const [error, setError] = useState<string>();
  const back = () => navigate("/vpn/sites");
  const read = (text: string) => {
    setCode(text);
    if (!text.trim()) return setError(undefined);
    try {
      const invite = decodeInvite(text);
      setSite({ name: invite.name, public_key: invite.public_key, subnets: invite.subnets, ...(invite.endpoint ? { endpoint: invite.endpoint } : {}) });
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const add = () => {
    const id = `s${Math.max(0, ...intent.vpn.sites.peers.map((p) => Number(p.id.slice(1)))) + 1}`;
    draft.replace({ ...intent, vpn: { ...intent.vpn, sites: { ...intent.vpn.sites, peers: [...intent.vpn.sites.peers, { id, ...site }] } } });
    back();
  };
  return (
    <SettingsPage
      title={[{ label: "Sites", onClick: back }, { label: site.name || "New site" }]}
      actions={
        <>
          <Button variant="default" onClick={back}>
            Cancel
          </Button>
          <Button onClick={add} disabled={!site.name || !site.public_key || !site.subnets.length}>
            Add site
          </Button>
        </>
      }
    >
      <Section title="Its invitation" description="From the other site's Sites page: paste it, and the rest is filled in.">
        <Textarea value={code} onChange={(e) => read(e.currentTarget.value)} minRows={3} autosize ff="monospace" p="sm" placeholder="onc-site:…" />
      </Section>
      {error && <Alert color="red">{error}</Alert>}
      <Section title="Or by hand">
        <SettingRow label="Name">
          <TextInput value={site.name} onChange={(e) => setSite({ ...site, name: e.currentTarget.value })} w={260} />
        </SettingRow>
        <SettingRow label="Its key" description="Its public WireGuard key.">
          <TextInput value={site.public_key} onChange={(e) => setSite({ ...site, public_key: e.currentTarget.value.trim() })} w={260} ff="monospace" />
        </SettingRow>
        <SettingRow label="Its address" description="host:port; unset, it connects here.">
          <TextInput
            value={site.endpoint ?? ""}
            onChange={(e) => {
              const { endpoint: _, ...rest } = site;
              setSite(e.currentTarget.value ? { ...rest, endpoint: e.currentTarget.value.trim() } : rest);
            }}
            w={260}
          />
        </SettingRow>
        <SettingRow label="Its networks" description="Comma-separated ranges, like 192.168.50.0/24.">
          <TextInput
            value={site.subnets.join(", ")}
            onChange={(e) => setSite({ ...site, subnets: e.currentTarget.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            w={260}
          />
        </SettingRow>
      </Section>
    </SettingsPage>
  );
};

const sitesList = defineList({
  name: "vpn.sites.peers",
  title: "Linked sites",
  addLabel: "Add site",
  newPage: <NewSitePage />,
  itemTitle: (i) => <Value name={`vpn.sites.peers.${i}.name`} fallback="Site" />,
  empty: "No sites linked yet.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <ItemName icon={<ItemIcon icon={IconBuildingCommunity} color="cyan" />}>
          <Value name={`vpn.sites.peers.${i}.name`} fallback="Unnamed" />
        </ItemName>
      ),
    },
    {
      header: "Its networks",
      cell: (i) => (
        <Text size="sm" c="dimmed" ff="monospace">
          <Value name={`vpn.sites.peers.${i}.subnets`} format={(s) => ((s as string[]) ?? []).join(", ")} />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <Section>
      <TextField name={`vpn.sites.peers.${i}.name`} label="Name" />
      <TextField name={`vpn.sites.peers.${i}.public_key`} label="Its key" />
      <TextField name={`vpn.sites.peers.${i}.endpoint`} label="Its address" placeholder="cabin.example.com:51821" />
      <TagsField name={`vpn.sites.peers.${i}.subnets`} label="Its networks" placeholder="Add a range" />
    </Section>
  ),
});

/** This site's invitation, for the other one; and its port and access. */
const ThisSite = () => {
  const draft = useDraft();
  const intent: Intent = useDraftValue();
  const invite = inviteOf(intent);
  if (!invite) {
    return (
      <Section title="This site">
        <SettingRow label="Link sites" description="Makes this site's key, for others to link to it.">
          <Button size="xs" onClick={() => draft.set("vpn.sites.private_key", newPrivateKey())}>
            Start
          </Button>
        </SettingRow>
      </Section>
    );
  }
  const code = encodeInvite(invite);
  return (
    <>
      <Section
        title="This site"
        description={
          vpnEndpoint(intent)
            ? "Paste this into the other site's Sites page: then add its invitation here."
            : `Set a name on the internet (${where("internet")}) first, or the other site must connect to you.`
        }
      >
        <SettingRow label="Invitation">
          <Group gap={6} wrap="nowrap">
            <Code style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{code}</Code>
            <CopyButton value={code}>
              {({ copied, copy }) => (
                <Button size="xs" variant="default" onClick={copy}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              )}
            </CopyButton>
          </Group>
        </SettingRow>
        <NumberField name="vpn.sites.port" label="Port" min={1} max={65535} integer />
      </Section>
      <ZoneAccess base="sites" />
    </>
  );
};

export const SitesPage = ({ sub }: { sub: string }) => {
  const intent: Intent = useDraftValue();
  return intent.vpn.sites.private_key ? (
    <ListPage
      list={sitesList}
      sub={sub}
      base="/vpn/sites"
      page={{ title: <Experimental>Sites</Experimental>, description: "Other places linked to this one.", before: <ThisSite /> }}
    />
  ) : (
    <SettingsPage title={<Experimental>Sites</Experimental>} description="Other places linked to this one.">
      <ThisSite />
    </SettingsPage>
  );
};
