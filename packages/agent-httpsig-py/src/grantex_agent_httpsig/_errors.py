# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations


class AgentHttpSigError(ValueError):
    """Input the library refuses to process.

    A malformed structured field, a signature base that cannot be built (RFC
    9421 section 2.5), a key or option outside the profile. A request that
    fails verification is not an error: ``verify()`` answers it with a denial.
    """
