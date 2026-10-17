// VPN › Providers: tunnels a network's internet can go out through (its
// Internet line), from the provider's own file: WireGuard's .conf, read into
// fields, or OpenVPN's .ovpn, kept as given.
import { Alert, Button, PasswordInput, SegmentedControl, Text, Textarea, TextInput } from "@mantine/core";
import { IconShieldLock } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { withoutProvider } from "../../../../src/intent/edits";
import { ovpnUnsafe } from "../../../../src/intent/vpn";
import { where } from "../../../../src/intent/places";
import { Intent } from "../../../../src/intent/schema";
import { parseWgConf } from "../../../../src/wireguardConf";
import { setIn, useDraft, useDraftValue } from "../../form/draft";
import { NumberField, PasswordField, TagsField, TextField, Value } from "../../form/fields";
import { addChecked, defineList, ListPage } from "../../form/ListPage";
import { Experimental, ItemIcon, ItemName, Section, SettingRow, SettingsPage } from "../../kit/layout";

type Tunnel = Intent["vpn"]["providers"][number];

/** A tunnel from a provider's file, or why the file will not do. */
const fromFile = (kind: Tunnel["type"], id: string, name: string, text: string, login: { username: string; password: string }): Tunnel => {
  if (kind === "openvpn") {
    if (!/^\s*remote\s/m.test(text)) throw new Error("No remote in it: is it an .ovpn?");
    const unsafe = ovpnUnsafe(text);
    if (unsafe.length) {
      throw new Error(`It sets options a provider's file may not, as they could run or write things on the router: ${unsafe.join(", ")}. Remove those lines and paste it again.`);
    }
    return {
      id,
      name,
      type: "openvpn",
      config: text,
      ...(login.username ? { username: login.username, password: login.password } : {}),
    };
  }
  const conf = parseWgConf(text);
  const address = conf.addresses.find((a) => !a.includes(":"));
  if (!address) throw new Error("No IPv4 Address in its [Interface].");
  if (!conf.peer.endpoint) throw new Error("No Endpoint in its [Peer].");
  return {
    id,
    name,
    type: "wireguard",
    private_key: conf.privateKey,
    address: address.includes("/") ? address : `${address}/32`,
    ...(conf.dns.filter((d) => !d.includes(":")).length ? { dns: conf.dns.filter((d) => !d.includes(":")) } : {}),
    ...(conf.mtu ? { mtu: conf.mtu } : {}),
    peer: {
      public_key: conf.peer.publicKey,
      ...(conf.peer.presharedKey ? { preshared_key: conf.peer.presharedKey } : {}),
      endpoint: conf.peer.endpoint,
    },
  };
};

const NewProviderPage = () => {
  const navigate = useNavigate();
  const draft = useDraft();
  const intent: Intent = useDraftValue();
  const [kind, setKind] = useState<Tunnel["type"]>("wireguard");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [login, setLogin] = useState({ username: "", password: "" });
  // What was wrong with the provider as it was when Add was pressed: gone once anything is edited.
  const [failed, setFailed] = useState<{ message: string; inputs: string }>();
  const inputs = JSON.stringify([kind, name, text, login]);
  const error = failed?.inputs === inputs ? failed.message : undefined;
  const setError = (message: string) => setFailed({ message, inputs });
  const back = () => navigate("/settings/vpn/providers");
  const free = [...Array(9).keys()].map((n) => `tun${n + 1}`).find((id) => !intent.vpn.providers.some((t) => t.id === id));
  const add = () => {
    try {
      if (!free) throw new Error("Nine providers at most.");
      const providers = [...intent.vpn.providers, fromFile(kind, free, name.trim(), text, login)];
      const problem = addChecked(draft, setIn(intent, "vpn.providers", providers), `vpn.providers.${providers.length - 1}`);
      if (problem) return setError(problem);
      back();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <SettingsPage
      title={[{ label: "Providers", onClick: back }, { label: name || "New provider" }]}
      actions={
        <>
          <Button variant="default" onClick={back}>
            Cancel
          </Button>
          <Button onClick={add} disabled={!name.trim() || !text.trim()}>
            Add provider
          </Button>
        </>
      }
    >
      <Section>
        <SettingRow label="Name">
          <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Mullvad" w={260} />
        </SettingRow>
        <SettingRow label="Kind" description="As your provider gives it.">
          <SegmentedControl
            value={kind}
            onChange={(v) => setKind(v as Tunnel["type"])}
            data={[
              { value: "wireguard", label: "WireGuard" },
              { value: "openvpn", label: "OpenVPN" },
            ]}
          />
        </SettingRow>
        {kind === "openvpn" && (
          <>
            <SettingRow label="Username" description="If your provider asks for one.">
              <TextInput value={login.username} onChange={(e) => setLogin({ ...login, username: e.currentTarget.value })} w={260} />
            </SettingRow>
            <SettingRow label="Password">
              <PasswordInput
                value={login.password}
                onChange={(e) => setLogin({ ...login, password: e.currentTarget.value })}
                w={260}
              />
            </SettingRow>
          </>
        )}
      </Section>
      <Section title={kind === "wireguard" ? "Its .conf" : "Its .ovpn"} description="Paste the file your provider gives you.">
        <Textarea
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          minRows={10}
          autosize
          ff="monospace"
          p="sm"
          placeholder={kind === "wireguard" ? "[Interface]\nPrivateKey = …" : "client\nremote …"}
        />
      </Section>
      {error && <Alert color="red">{error}</Alert>}
    </SettingsPage>
  );
};

/** The networks out through it, by their Internet line. */
const UsedBy = ({ index }: { index: number }) => {
  const intent: Intent = useDraftValue();
  const tunnel = intent.vpn.providers[index];
  const users = intent.networks.filter((n) => n.access.via === tunnel?.id).map((n) => n.name);
  return (
    <SettingRow label="Used by" description={`A network's Internet line sends it here (${where("networks")}).`}>
      <Text size="sm" c="dimmed">
        {users.length ? users.join(", ") : "No network yet"}
      </Text>
    </SettingRow>
  );
};

const providers = defineList({
  name: "vpn.providers",
  title: "Providers",
  addLabel: "Add provider",
  newPage: <NewProviderPage />,
  // Networks out through it go back to their usual line.
  onRemove: withoutProvider,
  itemTitle: (i) => <Value name={`vpn.providers.${i}.name`} fallback="Provider" />,
  empty: "No VPN providers. Add one, then choose it as a network's Internet line.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <ItemName icon={<ItemIcon icon={IconShieldLock} color="grape" />}>
          <Value name={`vpn.providers.${i}.name`} fallback="Unnamed" />
        </ItemName>
      ),
    },
    {
      header: "Kind",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value name={`vpn.providers.${i}.type`} format={(t) => (t === "openvpn" ? "OpenVPN" : "WireGuard")} />
        </Text>
      ),
    },
  ],
  editor: (i) => <ProviderEditor index={i} />,
});

const ProviderEditor = ({ index }: { index: number }) => {
  const tunnel: Tunnel | undefined = useDraftValue(`vpn.providers.${index}`);
  const at = `vpn.providers.${index}` as const;
  return (
    <>
      <Section>
        <TextField name={`${at}.name`} label="Name" />
        <UsedBy index={index} />
      </Section>
      <Section>
        {tunnel?.type === "wireguard" ? (
          <>
            <TextField name={`${at}.peer.endpoint`} label="Server address" />
            <TextField name={`${at}.address`} label="Address" />
            <NumberField name={`${at}.mtu`} label="MTU" min={1280} max={1500} integer />
          </>
        ) : (
          <>
            <TextField name={`${at}.username`} label="Username" />
            <PasswordField name={`${at}.password`} label="Password" />
          </>
        )}
        <TagsField name={`${at}.dns`} label="DNS servers" placeholder="Add a server" />
      </Section>
    </>
  );
};

export const ProvidersPage = ({ sub }: { sub: string }) => (
  <ListPage
    list={providers}
    sub={sub}
    base="/settings/vpn/providers"
    page={{ title: <Experimental>Providers</Experimental>, description: "Send a network's internet through a VPN provider." }}
  />
);
