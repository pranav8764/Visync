# Stage 1: Build the application
FROM maven:3.9.6-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
# Download dependencies first to cache them
RUN mvn dependency:go-offline
COPY src ./src
# Build the application
RUN mvn package -DskipTests

# Stage 2: Run the application
FROM eclipse-temurin:17-jre-jammy
WORKDIR /app
COPY --from=build /app/target/backend-0.0.1-SNAPSHOT.jar app.jar

# Run as non-root user for security
RUN useradd -m myuser
USER myuser

EXPOSE 8080

# Run with production profile active
ENTRYPOINT ["java", "-jar", "app.jar", "--spring.profiles.active=prod"]
