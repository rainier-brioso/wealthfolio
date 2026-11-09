import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportFormat, ImportType } from "@/lib/types";
import type { ImportMappingData } from "@/lib/types";
import { MappingHeaderCell } from "./mapping-table-cells";
import { fireEvent } from "@testing-library/react";
import { CALCULATED_UNIT_PRICE, FIXED_ACTIVITY_TYPE_PREFIX } from "../utils/mapping-values";

const mapping: ImportMappingData = {
  accountId: "account-1",
  importType: ImportType.ACTIVITY,
  name: "",
  fieldMappings: {},
  activityMappings: {},
  symbolMappings: {},
  accountMappings: {},
  symbolMappingMeta: {},
};

describe("MappingHeaderCell", () => {
  it("does not require a second security column when ISIN is already mapped", () => {
    render(
      <MappingHeaderCell
        field={ImportFormat.SYMBOL}
        mapping={{ ...mapping, fieldMappings: { isin: "ISIN" } }}
        headers={["ISIN"]}
        handleColumnMapping={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("Ignore");
  });
  it("offers a fixed type in the ordinary mapping selector", () => {
    const change = vi.fn();
    render(
      <div dir="rtl">
        <MappingHeaderCell
          field={ImportFormat.ACTIVITY_TYPE}
          mapping={mapping}
          headers={["Date"]}
          handleColumnMapping={change}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Fixed value: BUY" }));
    expect(change).toHaveBeenCalledWith(
      ImportFormat.ACTIVITY_TYPE,
      FIXED_ACTIVITY_TYPE_PREFIX + "BUY",
    );
  });

  it("shows the calculated-price choice instead of an unmapped-field error", () => {
    render(
      <MappingHeaderCell
        field={ImportFormat.UNIT_PRICE}
        mapping={{ ...mapping, fieldMappings: { unitPrice: CALCULATED_UNIT_PRICE } }}
        headers={["Amount", "Quantity"]}
        handleColumnMapping={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Calculate: amount / quantity");
  });
  it("shows the select-column placeholder for an unmapped required field", () => {
    render(
      <MappingHeaderCell
        field={ImportFormat.DATE}
        mapping={mapping}
        headers={["Date", "Amount"]}
        requiredFields={[ImportFormat.DATE]}
        handleColumnMapping={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("Select column");
  });
});
