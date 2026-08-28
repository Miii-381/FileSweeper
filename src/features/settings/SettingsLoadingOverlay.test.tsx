import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsLoadingOverlay } from "./SettingsLoadingOverlay";

describe("SettingsLoadingOverlay", () => {
  it("以模态状态提示许可证正在读取", () => {
    render(<SettingsLoadingOverlay />);

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("正在读取许可证").textContent).toBe("正在读取许可证");
  });
});
