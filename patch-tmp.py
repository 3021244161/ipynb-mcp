import re

p = 'src/kernel/registry.ts'
s = open(p, encoding='utf-8').read()

old = """      if (result.status === 'timeout') {
        // Timeout kills the kernel (SPEC §4.7 rule 6).
        await this.shutdown(notebookPath);
      }"""
new = """      if (result.status === 'timeout') {
        // Timeout kills the kernel (SPEC §4.7 rule 6). The timeout result is
        // the primary outcome: a failed cleanup must not replace it (the
        // session stays registered for shutdown_all to retry — review A30).
        try {
          await this.shutdown(notebookPath);
        } catch (shutdownCause) {
          this.#logger?.warn(`post-timeout shutdown failed for ${session.kernelId}: ${String(shutdownCause)}`);
        }
      }"""
assert old in s, 'timeout branch not found'
s = s.replace(old, new)
open(p, 'w', encoding='utf-8').write(s)
print('registry ok')
