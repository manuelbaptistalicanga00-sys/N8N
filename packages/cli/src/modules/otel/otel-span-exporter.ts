import type { Attributes } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { suppressTracing } from '@sentry/node';

type ExportCallback = (result: ExportResult) => void;

export function exportOutsideSentryTracing(exporter: SpanExporter): SpanExporter {
	return {
		export: (spans: ReadableSpan[], resultCallback: ExportCallback) =>
			suppressTracing(() => exporter.export(spans, resultCallback)),
		shutdown: async () => await exporter.shutdown(),
		forceFlush: async () => await exporter.forceFlush?.(),
	};
}

export function mergeResourceAttributes(
	exporter: SpanExporter,
	attributes: Attributes,
): SpanExporter {
	const overrides = resourceFromAttributes(attributes);
	const mergedResources = new WeakMap<Resource, Resource>();

	const mergedResource = (resource: Resource): Resource => {
		const cached = mergedResources.get(resource);
		if (cached) return cached;

		const merged = resource.merge(overrides);
		mergedResources.set(resource, merged);
		return merged;
	};

	return {
		export: (spans: ReadableSpan[], resultCallback: ExportCallback) =>
			exporter.export(
				spans.map((span) => withResource(span, mergedResource(span.resource))),
				resultCallback,
			),
		shutdown: async () => await exporter.shutdown(),
		forceFlush: async () => await exporter.forceFlush?.(),
	};
}

function withResource(span: ReadableSpan, resource: Resource): ReadableSpan {
	return {
		name: span.name,
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanContext: span.parentSpanContext,
		startTime: span.startTime,
		endTime: span.endTime,
		status: span.status,
		attributes: span.attributes,
		links: span.links,
		events: span.events,
		duration: span.duration,
		ended: span.ended,
		resource,
		instrumentationScope: span.instrumentationScope,
		droppedAttributesCount: span.droppedAttributesCount,
		droppedEventsCount: span.droppedEventsCount,
		droppedLinksCount: span.droppedLinksCount,
	};
}
