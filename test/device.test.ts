import { describe, expect, it } from "vitest";
import { describeTrigger } from "../src/automation";

describe("device trigger text", () => {
  it("names the device and the button press", () => {
    const hass: any = { devices: { d1: { name: "Master button" } }, states: {} };
    expect(describeTrigger({ trigger: "device", device_id: "d1", type: "remote_button_short_press", subtype: "button_2" }, hass))
      .toBe("Master button: Button 2 short press");
    expect(describeTrigger({ platform: "device", device_id: "d1", type: "remote_button_double_press" }, hass))
      .toBe("Master button: Button double press");
  });
});
