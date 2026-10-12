// SSH public key lines ("ssh-ed25519 AAAA… comment"), shared by the lockout
// guard and the UI, which shows them short.

/** A key's identity: its type and base64, without the comment. */
export const keyIdentity = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(" ");

/** A key in a few words: its type, its comment, and the end of the key itself. */
export const describeKey = (line: string) => {
  const [type = "", blob = "", ...comment] = line.trim().split(/\s+/);
  return { type: type.replace(/^ssh-/, ""), comment: comment.join(" "), tail: blob.replace(/=+$/, "").slice(-8) };
};
