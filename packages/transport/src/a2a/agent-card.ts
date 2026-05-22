import type { A2AAgentCard, A2ASkill, Agent } from "@agentium/core";

/**
 * Generate an A2A Agent Card from a Agentium Agent.
 * The card is served at /.well-known/agent.json per the A2A spec.
 */
export function generateAgentCard(
  agent: Agent,
  serverUrl: string,
  provider?: { organization: string; url?: string },
  version?: string,
): A2AAgentCard {
  const skills: A2ASkill[] = agent.tools.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: tool.description,
  }));

  if (skills.length === 0) {
    skills.push({
      id: "general",
      name: "General",
      description: typeof agent.instructions === "string" ? agent.instructions.slice(0, 200) : "General-purpose agent",
    });
  }

  const description = typeof agent.instructions === "string" ? agent.instructions : `Agentium agent: ${agent.name}`;

  return {
    name: agent.name,
    description,
    url: serverUrl,
    version: version ?? "1.0.0",
    provider,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    skills,
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    supportedInputModes: ["text/plain", "application/json"],
    supportedOutputModes: ["text/plain", "application/json"],
  };
}

/**
 * Generate a combined Agent Card that lists multiple agents as skills.
 */
export function generateMultiAgentCard(
  agents: Record<string, Agent>,
  serverUrl: string,
  provider?: { organization: string; url?: string },
  version?: string,
): A2AAgentCard {
  const skills: A2ASkill[] = Object.entries(agents).map(([name, agent]) => ({
    id: name,
    name: agent.name,
    description: typeof agent.instructions === "string" ? agent.instructions.slice(0, 200) : `Agent: ${name}`,
  }));

  return {
    name: "Agentium Agent Server",
    description: `Multi-agent server with ${Object.keys(agents).length} agents: ${Object.keys(agents).join(", ")}`,
    url: serverUrl,
    version: version ?? "1.0.0",
    provider,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    skills,
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    supportedInputModes: ["text/plain", "application/json"],
    supportedOutputModes: ["text/plain", "application/json"],
  };
}
