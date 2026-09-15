"""Tracing a recommendation back to upstream records, from the package alone."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Tuple

__all__ = ["upstream_records_for"]


def upstream_records_for(
    document: Mapping[str, Any], recommendation_id: str
) -> List[Dict[str, Any]]:
    """Every upstream record behind a recommendation.

    Follows the recommendation's section citations and the citations of the
    policy evaluation it is based on to the tool calls that retrieved each
    record. Returns one item per distinct (call, record), ordered by entry
    sequence then record position, with the citing field paths. Call this on
    a package that has passed :func:`verify_package`; it raises ``KeyError``
    for an unknown recommendation.
    """
    entries: List[Mapping[str, Any]] = document["entries"]
    calls: Dict[str, Tuple[int, Mapping[str, Any]]] = {}
    evaluations: Dict[str, Tuple[int, Mapping[str, Any]]] = {}
    recommendation: Tuple[int, Mapping[str, Any]] = (-1, {})
    for entry in entries:
        data = entry["data"]
        if entry["type"] == "tool_call":
            calls[data["call_id"]] = (entry["seq"], data)
        elif entry["type"] == "policy_evaluation":
            evaluations[data["evaluation_id"]] = (entry["seq"], data)
        elif entry["type"] == "recommendation" and data["recommendation_id"] == recommendation_id:
            recommendation = (entry["seq"], data)
    if recommendation[0] < 0:
        raise KeyError(recommendation_id)

    citations: List[Tuple[str, Mapping[str, Any]]] = []
    rec_seq, rec = recommendation
    for s, section in enumerate(rec["sections"]):
        for e, ref in enumerate(section["evidence"]):
            citations.append((f"entries[{rec_seq}].data.sections[{s}].evidence[{e}]", ref))
    eval_seq, evaluation = evaluations[rec["evaluation_id"]]
    for i, item in enumerate(evaluation["inputs"]):
        for e, ref in enumerate(item["evidence"]):
            citations.append((f"entries[{eval_seq}].data.inputs[{i}].evidence[{e}]", ref))

    found: Dict[Tuple[int, int], Dict[str, Any]] = {}
    for path, ref in citations:
        call_seq, call = calls[ref["call_id"]]
        for position, record in enumerate(call["upstream_records"]):
            if record["record_id"] != ref["record_id"]:
                continue
            key = (call_seq, position)
            item = found.get(key)
            if item is None:
                item = {
                    "call_id": call["call_id"],
                    "connector": call["connector"],
                    "tool": call["tool"],
                    "provider": call["provider"],
                    "grant_id": call["grant_id"],
                    "record_id": record["record_id"],
                    "retrieved_at": record["retrieved_at"],
                    "cited_by": [],
                }
                if "record_type" in record:
                    item["record_type"] = record["record_type"]
                found[key] = item
            item["cited_by"].append(path)
    return [found[key] for key in sorted(found)]
