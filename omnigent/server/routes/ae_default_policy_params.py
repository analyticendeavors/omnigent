"""Factory params on the global policy routes (AE patch).

The Global Policies page edits a global policy's parameters. Params are checked
against the registry schema and the factory is then built once, on create and
on update: the schema covers key names and JSON types only, and a stored policy
whose factory raises breaks policy evaluation for every session.
"""

from __future__ import annotations

from typing import Any

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.policies.function import resolve_function_policy
from omnigent.policies.registry import is_registered_handler, validate_factory_params
from omnigent.server.schemas import UpdateDefaultPolicyRequest
from omnigent.spec.types import FunctionPolicySpec, FunctionRef
from omnigent.stores.policy_store import PolicyStore


def ae_check_factory_params(name: str, handler: str, params: dict[str, Any] | None) -> None:
    """Raise 400 unless the schema accepts *params* and the factory builds with them.

    :param name: The policy's name, for the error.
    :param handler: The registered handler the params are for.
    :param params: The params as they will be stored (``None`` for none).
    :raises OmnigentError: 400 naming what is wrong and what to do.
    """
    problem = validate_factory_params(handler, params)
    if problem is not None:
        raise OmnigentError(
            f"{problem}. Change the params and save again.", code=ErrorCode.INVALID_INPUT
        )
    spec = FunctionPolicySpec(
        name=name, on=None, function=FunctionRef(path=handler, arguments=params)
    )
    try:
        resolve_function_policy(spec)
    except Exception as exc:
        raise OmnigentError(
            f"Policy '{name}' rejected these params: {exc}. Change them and save again.",
            code=ErrorCode.INVALID_INPUT,
        ) from exc


def ae_patch_factory_params(
    store: PolicyStore, policy_id: str, body: UpdateDefaultPolicyRequest
) -> dict[str, Any]:
    """Check the params a PATCH leaves the policy with; return any new ones.

    A new ``handler`` is checked against the stored params as well, so a
    handler change cannot leave params its factory rejects.

    :param store: The default policy store.
    :param policy_id: The policy being updated.
    :param body: The PATCH body.
    :returns: ``{"factory_params": params}`` when the body sets them, else ``{}``.
    :raises OmnigentError: 404 when the policy is missing; 400 when the
        params do not fit its handler or its factory rejects them.
    """
    params_sent = "factory_params" in body.model_fields_set
    if not params_sent and body.handler is None:
        return {}
    existing = store.get_default(policy_id)
    if existing is None:
        raise OmnigentError("Policy not found", code=ErrorCode.NOT_FOUND)
    if existing.type != "python":
        if params_sent:
            raise OmnigentError(
                "factory_params apply to python policies only; remove the field.",
                code=ErrorCode.INVALID_INPUT,
            )
        return {}
    handler = body.handler or existing.handler
    params = (body.factory_params or None) if params_sent else existing.factory_params
    if not is_registered_handler(handler):
        raise OmnigentError(
            f"Policy handler '{handler}' is not registered, so its params cannot be "
            "checked. Add the module that declares it to the server's 'policy_modules'.",
            code=ErrorCode.INVALID_INPUT,
        )
    ae_check_factory_params(existing.name, handler, params)
    return {"factory_params": params} if params_sent else {}
