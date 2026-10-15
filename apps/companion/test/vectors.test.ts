import { describe, expect, it } from 'vitest';
import { hex, unhex, utf8 } from '../src/protocol/bytes.ts';
import { AEAD_AES128, hkdf, hkdfExpand, hkdfExtract, importKemPrivateRaw, openBase, sealBase } from '../src/protocol/hpke.ts';
import { identityFromSeed, sign, verify } from '../src/protocol/keys.ts';

describe('published test vectors', () => {
  it('RFC 5869 test case 1 (HKDF-SHA256)', async () => {
    const ikm = unhex('0b'.repeat(22));
    const salt = unhex('000102030405060708090a0b0c');
    const info = unhex('f0f1f2f3f4f5f6f7f8f9');
    const prk = await hkdfExtract(salt, ikm);
    expect(hex(prk)).toBe('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');
    expect(hex(await hkdfExpand(prk, info, 42))).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
    expect(hex(await hkdf(ikm, salt, info, 42))).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  });

  it('RFC 5869 test case 3 (empty salt and info)', async () => {
    const ikm = unhex('0b'.repeat(22));
    expect(hex(await hkdf(ikm, new Uint8Array(0), new Uint8Array(0), 42))).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
  });

  it('RFC 8032 section 7.1 test 1 (Ed25519, empty message)', async () => {
    const id = await identityFromSeed(unhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'), true);
    expect(hex(id.pub)).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const sig = await sign(id, '');
    expect(hex(sig)).toBe('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
    expect(await verify(id.pub, sig, '')).toBe(true);
  });

  it('RFC 9180 A.1.1 (DHKEM X25519, HKDF-SHA256, AES-128-GCM, base mode): shared secret, key, nonce, ciphertext, and open', async () => {
    const skEm = await importKemPrivateRaw(unhex('52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736'), false);
    const pkEm = unhex('37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431');
    const pkRm = unhex('3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d');
    const skRm = await importKemPrivateRaw(unhex('4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8'), false);
    const info = unhex('4f6465206f6e2061204772656369616e2055726e');
    const pt = unhex('4265617574792069732074727574682c20747275746820626561757479');
    const aad = unhex('436f756e742d30');
    const r = await sealBase(pkRm, info, aad, pt, { aead: AEAD_AES128, ephemeral: { pub: pkEm, priv: skEm } });
    expect(hex(r.enc)).toBe('37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431');
    expect(hex(r.shared)).toBe('fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc');
    expect(hex(r.key)).toBe('4531685d41d65f03dc48f6b8302c05b0');
    expect(hex(r.baseNonce)).toBe('56d890e5accaaf011cff4b7d');
    expect(hex(r.ct)).toBe('f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a');
    const back = await openBase(r.enc, skRm, pkRm, info, aad, r.ct, { aead: AEAD_AES128 });
    expect(hex(back)).toBe(hex(pt));
  });

  it('HPKE rejects a wrong aad, a flipped bit and a wrong recipient (AES-256-GCM, our production suite)', async () => {
    const { generateKemKeyPair } = await import('../src/protocol/hpke.ts');
    const rcpt = await generateKemKeyPair();
    const other = await generateKemKeyPair();
    const info = utf8('t'); const aad = utf8('a');
    const r = await sealBase(rcpt.pub, info, aad, utf8('hello'));
    expect(new TextDecoder().decode(await openBase(r.enc, rcpt.priv, rcpt.pub, info, aad, r.ct))).toBe('hello');
    await expect(openBase(r.enc, rcpt.priv, rcpt.pub, info, utf8('b'), r.ct)).rejects.toThrow();
    const bad = r.ct.slice(); bad[0] = bad[0]! ^ 1;
    await expect(openBase(r.enc, rcpt.priv, rcpt.pub, info, aad, bad)).rejects.toThrow();
    await expect(openBase(r.enc, other.priv, other.pub, info, aad, r.ct)).rejects.toThrow();
  });
});
