use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer, Serialize};
use std::str::FromStr;

pub(crate) const METADATA_KEY: &str = "source_reconciliation";
const ISSUE_CODE: &str = "myinvestor_settlement_difference";
const REFERENCE_URL: &str = "https://www.rankia.com/foros/fondos-inversion/temas/4472241-seguimiento-opiniones-myinvestor?page=575";

/// An import-only snapshot. It is evidence, not an instruction to book more cash.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceReconciliation {
    pub version: u8,
    pub issue_code: String,
    pub reason_code: String,
    pub trade_date: String,
    pub settlement_date: String,
    pub operation_reference: String,
    pub isin: String,
    pub source_file: String,
    pub source_row: u32,
    pub currency: String,
    pub quantity: String,
    pub unit_price: String,
    pub source_amount: String,
    pub settled_amount: String,
    pub calculated_amount: String,
    pub difference: String,
    pub reference_url: String,
}

impl SourceReconciliation {
    fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || self.issue_code != ISSUE_CODE
            || self.reason_code != "undetermined"
            || self.reference_url != REFERENCE_URL
            || self.source_row == 0
            || self.source_file.len() > 255
            || self.operation_reference.len() > 128
            || self.isin.len() > 32
            || self.currency.is_empty()
            || self.currency.len() > 12
            || chrono::NaiveDate::parse_from_str(&self.trade_date, "%Y-%m-%d").is_err()
            || chrono::NaiveDate::parse_from_str(&self.settlement_date, "%Y-%m-%d").is_err()
        {
            return Err("Invalid source reconciliation identity");
        }
        let parse = |value: &str| {
            if value.len() > 64 {
                return Err("Invalid source reconciliation decimal");
            }
            Decimal::from_str(value).map_err(|_| "Invalid source reconciliation decimal")
        };
        let quantity = parse(&self.quantity)?;
        let price = parse(&self.unit_price)?;
        let source = parse(&self.source_amount)?;
        let settled = parse(&self.settled_amount)?;
        let calculated = parse(&self.calculated_amount)?;
        let difference = parse(&self.difference)?;
        if quantity <= Decimal::ZERO
            || price <= Decimal::ZERO
            || source < Decimal::ZERO
            || settled < Decimal::ZERO
            || quantity.checked_mul(price) != Some(calculated)
            || calculated.checked_add(difference) != Some(settled)
        {
            return Err("Inconsistent source reconciliation amounts");
        }
        Ok(())
    }
}

pub(crate) fn deserialize_optional<'de, D>(
    deserializer: D,
) -> Result<Option<SourceReconciliation>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<SourceReconciliation>::deserialize(deserializer)?;
    if let Some(snapshot) = &value {
        snapshot.validate().map_err(serde::de::Error::custom)?;
    }
    Ok(value)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn fixture() -> serde_json::Value {
        serde_json::json!({
            "version": 1, "issueCode": ISSUE_CODE, "reasonCode": "undetermined",
            "tradeDate": "2026-01-02", "settlementDate": "2026-01-05",
            "operationReference": "TEST-1", "isin": "IE000ZYRH0Q7",
            "sourceFile": "operations.xls", "sourceRow": 3, "currency": "EUR",
            "quantity": "2", "unitPrice": "24.99", "sourceAmount": "50",
            "settledAmount": "50", "calculatedAmount": "49.98", "difference": "0.02",
            "referenceUrl": REFERENCE_URL
        })
    }

    #[test]
    fn validates_original_reconciliation_without_booking_instructions() {
        let text = fixture().to_string();
        let value = deserialize_optional(&mut serde_json::Deserializer::from_str(&text)).unwrap();
        assert_eq!(serde_json::to_value(value).unwrap(), fixture());
    }

    #[test]
    fn rejects_inconsistent_amounts_and_unsafe_reference_urls() {
        for (key, value) in [
            ("difference", "1"),
            ("calculatedAmount", "48"),
            ("quantity", "0"),
            ("referenceUrl", "javascript:alert(1)"),
            ("tradeDate", "invalid"),
            ("reasonCode", "commission"),
        ] {
            let mut fixture = fixture();
            fixture[key] = serde_json::json!(value);
            let text = fixture.to_string();
            assert!(deserialize_optional(&mut serde_json::Deserializer::from_str(&text)).is_err());
        }
    }

    #[test]
    fn import_conversion_retains_source_reconciliation_and_cash_boundary() {
        let imported: crate::activities::ActivityImport =
            serde_json::from_value(serde_json::json!({
                "date": "2026-01-02", "symbol": "", "activityType": "CREDIT", "currency": "EUR",
                "isDraft": false, "isValid": true, "isExternal": true,
                "quantity": "2", "unitPrice": "24.99", "amount": "50",
                "comment": "Unchanged source reference", "sourceReconciliation": fixture()
            }))
            .unwrap();
        let original_json = serde_json::to_value(&imported).unwrap();
        assert_eq!(original_json["sourceReconciliation"], fixture());
        let converted = crate::activities::NewActivity::from(imported);
        let metadata: serde_json::Value =
            serde_json::from_str(converted.metadata.as_deref().unwrap()).unwrap();
        assert_eq!(metadata[METADATA_KEY], fixture());
        assert_eq!(metadata["flow"]["is_external"], true);
        assert_eq!(converted.amount, Some(Decimal::from(50)));
        assert_eq!(
            converted.notes.as_deref(),
            Some("Unchanged source reference")
        );
    }
}
