import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const name = "helloworld";

// Create a GKE cluster

const engineVersion = gcp.container.getEngineVersions().then(v => v.latestMasterVersion);
const cluster = new gcp.container.Cluster(name, {
    initialNodeCount: 2,
    minMasterVersion: engineVersion,
    nodeVersion: engineVersion,
    nodeConfig: {
        machineType: "n1-standard-1",
        //machineType: "t2a-standard-1",
        diskType: "pd-standard", // Set the disk type to Persistent Disk Standard
        oauthScopes: [
            "https://www.googleapis.com/auth/compute",
            "https://www.googleapis.com/auth/devstorage.read_only",
            "https://www.googleapis.com/auth/logging.write",
            "https://www.googleapis.com/auth/monitoring"
        ],
    },
});

// Export the Cluster name
export const clusterName = cluster.name;

// Manufacture a GKE-style kubeconfig. Note that this is slightly "different"
// because of the way GKE requires gcloud to be in the picture for cluster
// authentication (rather than using the client cert/key directly).
export const kubeconfig = pulumi.
    all([ cluster.name, cluster.endpoint, cluster.masterAuth ]).
    apply(([ name, endpoint, masterAuth ]) => {
        const context = `${gcp.config.project}_${gcp.config.zone}_${name}`;
        return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${masterAuth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      installHint: Install gke-gcloud-auth-plugin for use with kubectl by following
        https://cloud.google.com/blog/products/containers-kubernetes/kubectl-auth-changes-in-gke
      provideClusterInfo: true
`;
    });

// Create a Kubernetes provider instance that uses our cluster from above.
const clusterProvider = new k8s.Provider(name, {
    kubeconfig: kubeconfig,
});
// Create a Kubernetes Namespace
const ns = new k8s.core.v1.Namespace(name, {}, { provider: clusterProvider });

// Export the Namespace name
export const namespaceName = ns.metadata.apply(m => m.name);

// Create a NGINX Deployment
const appLabels = { appClass: name };
const deployment = new k8s.apps.v1.Deployment(name,
    {
        metadata: {
            namespace: namespaceName,
            labels: appLabels,
        },
        spec: {
            replicas: 1,
            selector: { matchLabels: appLabels },
            template: {
                metadata: {
                    labels: appLabels,
                },
                spec: {
                    containers: [
                        {
                            name: name,
                            image: "nginx:latest",
                            ports: [{ name: "http", containerPort: 80 }]
                        }
                    ],
                }
            }
        },
    },
    {
        provider: clusterProvider,
    }
);

// Export the Deployment name
export const deploymentName = deployment.metadata.apply(m => m.name);

// Create a LoadBalancer Service for the NGINX Deployment
const service = new k8s.core.v1.Service(name,
    {
        metadata: {
            labels: appLabels,
            namespace: namespaceName,
        },
        spec: {
            type: "LoadBalancer",
            ports: [{ port: 80, targetPort: "http" }],
            selector: appLabels,
        },
    },
    {
        provider: clusterProvider,
    }
);

// Export the Service name and public LoadBalancer endpoint
export const serviceName = service.metadata.apply(m => m.name);
export const servicePublicIP = service.status.apply(s => s.loadBalancer.ingress[0].ip)

// Create resources for the Kubernetes Guestbook from its YAML manifests
const guestbook = new k8s.yaml.ConfigFile("guestbook",
    {
        file: "https://raw.githubusercontent.com/pulumi/pulumi-kubernetes/master/tests/sdk/nodejs/examples/yaml-guestbook/yaml/guestbook.yaml",
        transformations: [
            (obj: any) => {
                // Do transformations on the YAML to use the same namespace and
                // labels as the NGINX stack above
                if (obj.metadata.labels) {
                    obj.metadata.labels['appClass'] = namespaceName
                } else {
                    obj.metadata.labels = appLabels
                }

                // Make the 'frontend' Service public by setting it to be of type
                // LoadBalancer
                if (obj.kind == "Service" && obj.metadata.name == "frontend") {
                    if (obj.spec) {
                        obj.spec.type = "LoadBalancer"
                    }
                }
            }
        ],
    },
    {
       //providers: { "kubernetes": clusterProvider },
       provider: clusterProvider,
    },
);

// Export the Guestbook public LoadBalancer endpoint
export const guestbookPublicIP =
    guestbook.getResourceProperty("v1/Service", "frontend", "status").apply(s => s.loadBalancer.ingress[0].ip);