import nacl from "tweetnacl";
import { NanoPayBuyer } from "./buyer";

const keypair = nacl.sign.keyPair();
const BUYER_ADDRESS = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const SELLER_ADDRESS = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";

const buyer = new NanoPayBuyer({
  keypair,
  address: BUYER_ADDRESS,
  gatewayUrl: "http://localhost:4030",
});

describe("NanoPayBuyer", () => {
  describe("signAuthorization", () => {
    const auth = buyer.signAuthorization({
      to: SELLER_ADDRESS,
      amount: 5000n,
      validForSeconds: 600,
    });

    it("returns correct from address", () => {
      expect(auth.from).toBe(BUYER_ADDRESS);
    });

    it("returns correct to address", () => {
      expect(auth.to).toBe(SELLER_ADDRESS);
    });

    it("returns amount as a string", () => {
      expect(auth.amount).toBe("5000");
      expect(typeof auth.amount).toBe("string");
    });

    it("returns validBefore roughly now + validForSeconds", () => {
      const expectedValidBefore = Math.floor(Date.now() / 1000) + 600;
      expect(auth.validBefore).toBeGreaterThanOrEqual(expectedValidBefore - 5);
      expect(auth.validBefore).toBeLessThanOrEqual(expectedValidBefore + 5);
    });

    it("returns a 64-character hex nonce", () => {
      expect(auth.nonce).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns a 128-character hex signature (64 bytes)", () => {
      expect(auth.signature).toMatch(/^[0-9a-f]{128}$/);
    });

    it("produces different nonces on successive calls", () => {
      const auth1 = buyer.signAuthorization({
        to: SELLER_ADDRESS,
        amount: 1000n,
      });
      const auth2 = buyer.signAuthorization({
        to: SELLER_ADDRESS,
        amount: 1000n,
      });
      expect(auth1.nonce).not.toBe(auth2.nonce);
    });

    it("defaults validForSeconds to 300", () => {
      const authDefault = buyer.signAuthorization({
        to: SELLER_ADDRESS,
        amount: 1000n,
      });
      const expectedValidBefore = Math.floor(Date.now() / 1000) + 300;
      expect(authDefault.validBefore).toBeGreaterThanOrEqual(
        expectedValidBefore - 5
      );
      expect(authDefault.validBefore).toBeLessThanOrEqual(
        expectedValidBefore + 5
      );
    });
  });

  describe("getPublicKey", () => {
    it("returns the correct hex public key", () => {
      const pubkeyHex = buyer.getPublicKey();
      expect(pubkeyHex).toBe(Buffer.from(keypair.publicKey).toString("hex"));
    });

    it("returns a 64-character hex string (32 bytes)", () => {
      expect(buyer.getPublicKey()).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
