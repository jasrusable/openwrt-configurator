// VPN › Remote access: the WireGuard server on the router, and its clients.
// A client's key pair is made in this page; its private key is shown once,
// as a QR code and a file, and only its public key is kept.
import { Alert, Button, SegmentedControl, Text, TextInput } from "@mantine/core";
import { IconDeviceMobile } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { where } from "../../../../src/intent/places";
import { Intent } from "../../../../src/intent/schema";
import { clientAddresses, clientConf, nextClientHost, vpnEndpoint, VpnClient } from "../../../../src/intent/vpn";
import { newPrivateKey, publicKeyOf } from "../../../../src/wireguard";
import { useDraft, useDraftValue } from "../../form/draft";
import { NumberField, SegmentedField, SwitchField, TextField, Value } from "../../form/fields";
import { defineList, ListPage } from "../../form/ListPage";
import { ItemIcon, ItemName, Section, SettingRow, SettingsPage } from "../../kit/layout";
import { Experimental, KeyPanel, ZoneAccess } from "./shared";

const routes = [
  { value: "home", label: "Only your networks" },
  { value: "all", label: "Everything" },
] as const;

/** A new client: its name and route, then its key, made here and shown once. */
const NewClientPage = () => {
  const navigate = useNavigate();
  const draft = useDraft();
  const intent: Intent = useDraftValue();
  const [name, setName] = useState("");
  const [route, setRoute] = useState<VpnClient["route"]>("home");
  const [made, setMade] = useState<{ client: VpnClient; privateKey: string }>();
  const back = () => navigate("/vpn");
  const add = () => {
    const host = nextClientHost(intent.vpn.remote_access.clients);
    if (!host || !name.trim()) return;
    const privateKey = newPrivateKey();
    const id = `c${Math.max(0, ...intent.vpn.remote_access.clients.map((c) => Number(c.id.slice(1)))) + 1}`;
    const client: VpnClient = { id, name: name.trim(), public_key: publicKeyOf(privateKey), host, route };
    draft.replace({
      ...intent,
      vpn: { ...intent.vpn, remote_access: { ...intent.vpn.remote_access, clients: [...intent.vpn.remote_access.clients, client] } },
    });
    setMade({ client, privateKey });
  };
  return (
    <SettingsPage
      title={[{ label: "Remote access", onClick: back }, { label: made?.client.name || "New client" }]}
      actions={
        !made && (
          <>
            <Button variant="default" onClick={back}>
              Cancel
            </Button>
            <Button onClick={add} disabled={!name.trim()}>
              Add client
            </Button>
          </>
        )
      }
    >
      {made ? (
        <KeyPanel name={made.client.name} conf={clientConf(intent, made.client, made.privateKey)} onDone={back} />
      ) : (
        <Section>
          <SettingRow label="Name" description="The phone or laptop.">
            <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Phone" w={260} />
          </SettingRow>
          <SettingRow label="Through home" description="Everything is safer on public Wi-Fi; your networks only is faster.">
            <SegmentedControl value={route} onChange={(v) => setRoute(v as VpnClient["route"])} data={[...routes]} />
          </SettingRow>
        </Section>
      )}
    </SettingsPage>
  );
};

/** A new key for a client (a lost phone's, say): its old one stops working once applied. */
const ReplaceKey = ({ index }: { index: number }) => {
  const draft = useDraft();
  const intent: Intent = useDraftValue();
  const [privateKey, setPrivateKey] = useState<string>();
  const client = intent.vpn.remote_access.clients[index];
  if (!client) return null;
  if (privateKey) {
    return <KeyPanel name={client.name} conf={clientConf(intent, client, privateKey)} onDone={() => setPrivateKey(undefined)} />;
  }
  return (
    <Section>
      <SettingRow label="Key" description="Lost the device, or the file? A new key; the old one stops working once applied.">
        <Button
          variant="default"
          size="xs"
          onClick={() => {
            const key = newPrivateKey();
            draft.set(`vpn.remote_access.clients.${index}.public_key`, publicKeyOf(key));
            setPrivateKey(key);
          }}
        >
          New key
        </Button>
      </SettingRow>
    </Section>
  );
};

const clients = defineList({
  name: "vpn.remote_access.clients",
  title: "Clients",
  addLabel: "Add client",
  newPage: <NewClientPage />,
  itemTitle: (i) => <Value name={`vpn.remote_access.clients.${i}.name`} fallback="Client" />,
  empty: "No clients yet.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <ItemName icon={<ItemIcon icon={IconDeviceMobile} color="teal" />}>
          <Value name={`vpn.remote_access.clients.${i}.name`} fallback="Unnamed" />
        </ItemName>
      ),
    },
    { header: "Address", cell: (i) => <ClientAddress index={i} /> },
    {
      header: "Through home",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value name={`vpn.remote_access.clients.${i}.route`} format={(r) => (r === "all" ? "Everything" : "Your networks")} />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField name={`vpn.remote_access.clients.${i}.name`} label="Name" />
        <SegmentedField name={`vpn.remote_access.clients.${i}.route`} label="Through home" options={[...routes]} />
        <SettingRow label="Address">
          <ClientAddress index={i} />
        </SettingRow>
      </Section>
      <ReplaceKey index={i} />
    </>
  ),
});

const ClientAddress = ({ index }: { index: number }) => {
  const intent: Intent = useDraftValue();
  const client = intent.vpn.remote_access.clients[index];
  return (
    <Text size="sm" c="dimmed" ff="monospace">
      {client ? clientAddresses(intent, client)[0] : ""}
    </Text>
  );
};

const Settings = () => {
  const intent: Intent = useDraftValue();
  return (
    <>
      <Section>
        <SwitchField name="vpn.remote_access.enabled" label="Remote access" />
      </Section>
      {intent.vpn.remote_access.enabled && (
        <>
          {!vpnEndpoint(intent) && (
            <Alert color="orange" title="Where should clients connect?">
              Give an address below, or set up a name that follows your address ({where("internet")}).
            </Alert>
          )}
          <Section>
            <TextField
              name="vpn.remote_access.endpoint"
              label="Address"
              placeholder={intent.internet.dynamic_dns?.hostname ?? "home.example.com"}
            />
            <NumberField name="vpn.remote_access.port" label="Port" min={1} max={65535} integer />
            <TextField name="vpn.remote_access.subnet" label="Addresses" />
          </Section>
          <ZoneAccess base="vpn" />
        </>
      )}
    </>
  );
};

export const RemoteAccessPage = ({ sub }: { sub: string }) => {
  const intent: Intent = useDraftValue();
  return intent.vpn.remote_access.enabled ? (
    <ListPage
      list={clients}
      sub={sub}
      base="/vpn"
      page={{ title: <Experimental>Remote access</Experimental>, description: "Your phones and laptops, home from anywhere.", before: <Settings /> }}
    />
  ) : (
    <SettingsPage title={<Experimental>Remote access</Experimental>} description="Your phones and laptops, home from anywhere.">
      <Settings />
    </SettingsPage>
  );
};
