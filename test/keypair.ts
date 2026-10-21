/**
 * Tests only: ssh2 now and then generates an Ed25519 key it cannot parse back
 * (the reason keys.ts retries). Tests that need a key use this, so they do
 * not fail one run in a few hundred.
 */
import ssh2 from 'ssh2';

const { utils } = ssh2;

type Options = Parameters<typeof utils.generateKeyPairSync>[1];

export function ed25519Pair(options?: Options): { private: string; public: string } {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pair = options
      ? utils.generateKeyPairSync('ed25519', options)
      : utils.generateKeyPairSync('ed25519');
    const passphrase = (options as { passphrase?: string } | undefined)?.passphrase;
    const priv = utils.parseKey(pair.private, passphrase);
    const pub = utils.parseKey(pair.public);
    if (
      !(priv instanceof Error) &&
      !Array.isArray(priv) &&
      !(pub instanceof Error) &&
      !Array.isArray(pub)
    ) {
      return pair;
    }
  }
  throw new Error('Could not generate a usable Ed25519 key');
}
