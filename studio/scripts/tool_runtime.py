"""External metadata tools: explicit overrides, no shell, actionable launch errors."""
import os
import subprocess


def run_tool(tool, args, **kwargs):
    variable = 'STUDIO_' + tool.upper()
    command = os.environ.get(variable, tool)
    try:
        return subprocess.run([command, *args], **kwargs)
    except OSError as error:
        raise ValueError(
            f'{tool} could not start. Install {tool} and add it to PATH, '
            f'or set {variable} to its executable. Run Check setup in Ride Studio.'
        ) from error
