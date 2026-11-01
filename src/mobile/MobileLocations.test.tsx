import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileLocations } from "./MobileLocations";

const { mobileCall } = vi.hoisted(() => ({ mobileCall: vi.fn() }));
vi.mock("./mobile-api", () => ({ mobileCall }));
vi.mock("../app-utils", () => ({ errorMessage: String, writeClientLog: vi.fn() }));
const root = "/storage/emulated/0";
function setup() {
  const save = vi.fn();
  render(<MobileLocations root={root} currentPath={`${root}/Download`} favorites={[]} save={save} open={vi.fn()} openTrash={vi.fn()} browse={vi.fn()} chosen={null} />);
  fireEvent.click(screen.getByRole("button", { name: "添加喜好路径" }));
  return save;
}
describe("自定义喜好路径", () => {
  beforeEach(() => { mobileCall.mockReset(); });
  it("校验并使用原生端返回的规范目录保存自定义名称", async () => {
    mobileCall.mockResolvedValue({ path: `${root}/Pictures` });
    const save = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "喜好目录路径" }), { target: { value: `${root}/Pictures/` } });
    fireEvent.change(screen.getByRole("textbox", { name: "喜好路径名称" }), { target: { value: "图片整理" } });
    fireEvent.click(screen.getByRole("button", { name: "保存喜好路径" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith([{ path: `${root}/Pictures`, name: "图片整理" }]));
  });
  it("不可访问的目录不保存，保留输入供修正", async () => {
    mobileCall.mockImplementation(() => Promise.reject(new Error("目录不存在")));
    const save = setup();
    fireEvent.click(screen.getByRole("button", { name: "保存喜好路径" }));
    await screen.findByRole("alert"); expect(save).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "喜好目录路径" }) as HTMLInputElement).value).toBe(`${root}/Download`);
  });
});
